import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  gitBranchList,
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitDiffFile,
  gitDiscard,
  gitFetch,
  gitLog,
  gitMerge,
  gitPull,
  gitPush,
  gitShow,
  gitStage,
  gitStatus,
  gitUnstage,
} from "../lib/ipc";
import {
  BranchIcon,
  CheckIcon,
  CommitIcon,
  DiscardIcon,
  FetchIcon,
  MergeIcon,
  MinusIcon,
  PlusIcon,
  PullIcon,
  PushIcon,
  RefreshIcon,
  SourceControlIcon,
} from "../lib/icons";
import type { BranchList, Commit, FileStatus, RepoStatus } from "../lib/types";

interface GitPaneProps {
  cwd: string;
  onShowDiff: (title: string, patch: string) => void;
}

const COMMIT_PAGE = 150;

/** Which sections are open. History stays open; the change lists follow VSCode. */
type SectionKey = "staged" | "changes" | "history";

/** What the branch popover is about to do with the branch you pick. */
type BranchMode = "checkout" | "merge";

/** Compact relative age, matching the density of the VSCode SCM view. */
function relativeAge(unixSeconds: number): string {
  const seconds = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  if (seconds < 2629800) return `${Math.floor(seconds / 604800)}w`;
  if (seconds < 31557600) return `${Math.floor(seconds / 2629800)}mo`;
  return `${Math.floor(seconds / 31557600)}y`;
}

/** A porcelain code with no index letter and a `?` is an untracked path. */
function isUntracked(file: FileStatus): boolean {
  return file.code.trim() === "??";
}

/**
 * Working-tree status, staging, commit, sync and branch operations for the
 * active repo, plus its commit history.
 *
 * Laid out like the VSCode SCM view: the commit box on top, then staged and
 * unstaged changes as separate collapsible groups, then history. Every mutating
 * call goes through `run`, which serialises the operations, surfaces git's own
 * error text and re-reads status afterwards — git is the single source of truth
 * here, so nothing is optimistically applied to local state.
 *
 * History is a flat list rather than a rendered lane graph; the `parents` and
 * `refs` fields are already carried through from Rust for when that lands.
 */
export const GitPane = memo(function GitPane({ cwd, onShowDiff }: GitPaneProps) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Last successful git output worth showing, e.g. what a push did. */
  const [note, setNote] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>({
    staged: false,
    changes: false,
    history: false,
  });
  const [branchMode, setBranchMode] = useState<BranchMode | null>(null);
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [branchFilter, setBranchFilter] = useState("");

  /** Bumped per refresh, so a slow scan for the previous cwd is dropped. */
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async () => {
    if (!cwd) return;
    const generation = (refreshGeneration.current += 1);
    try {
      const [nextStatus, nextCommits] = await Promise.all([
        gitStatus(cwd),
        gitLog(cwd, COMMIT_PAGE, 0, true),
      ]);
      if (generation !== refreshGeneration.current) return;
      setStatus(nextStatus);
      setCommits(nextCommits);
      setError(null);
    } catch (e) {
      if (generation !== refreshGeneration.current) return;
      setError(String(e));
      setStatus(null);
      setCommits([]);
    }
  }, [cwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A draft commit message belongs to the repo it was typed for, and so does
  // an open branch menu — both are wrong the moment the active repo changes.
  useEffect(() => {
    setMessage("");
    setNote(null);
    setBranchMode(null);
    setBranches(null);
  }, [cwd]);

  /**
   * Run one mutating git call, then re-read status.
   *
   * `label` doubles as the busy flag, so the toolbar can say what is in flight
   * and a second click cannot start a concurrent write to the same index.
   */
  const run = useCallback(
    async (label: string, action: () => Promise<string | void>) => {
      setBusy(label);
      setError(null);
      setNote(null);
      try {
        const output = await action();
        if (typeof output === "string" && output.trim()) setNote(output.trim());
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
        await refresh();
      }
    },
    [refresh],
  );

  const openFileDiff = useCallback(
    async (file: FileStatus, staged: boolean) => {
      try {
        const patch = await gitDiffFile(cwd, file.path, staged);
        onShowDiff(file.path, patch || `${file.code} ${file.path}\n\n(no textual diff)`);
      } catch (e) {
        onShowDiff(file.path, String(e));
      }
    },
    [cwd, onShowDiff],
  );

  const openCommit = useCallback(
    async (commit: Commit) => {
      setSelected(commit.sha);
      try {
        const patch = await gitShow(cwd, commit.sha);
        onShowDiff(`${commit.shortSha} ${commit.subject}`, patch);
      } catch (e) {
        onShowDiff(commit.shortSha, String(e));
      }
    },
    [cwd, onShowDiff],
  );

  /** A file with changes in both columns appears in both groups, as in VSCode. */
  const stagedFiles = useMemo(
    () => (status?.files ?? []).filter((f) => f.staged),
    [status],
  );
  const changedFiles = useMemo(
    () => (status?.files ?? []).filter((f) => f.unstaged),
    [status],
  );

  const stage = (paths: string[]) => void run("stage", () => gitStage(cwd, paths));
  const unstage = (paths: string[]) => void run("unstage", () => gitUnstage(cwd, paths));

  /** Irreversible, so it is the one action here that asks first. */
  const discard = (files: FileStatus[]) => {
    const tracked = files.filter((f) => !isUntracked(f)).map((f) => f.path);
    const untracked = files.filter(isUntracked).map((f) => f.path);
    const what =
      files.length === 1 ? files[0].path : `${files.length} files`;
    const deletes = untracked.length
      ? `\n\n${untracked.length} untracked file(s) will be deleted.`
      : "";
    if (!window.confirm(`Discard changes in ${what}? This cannot be undone.${deletes}`)) {
      return;
    }
    void run("discard", () => gitDiscard(cwd, tracked, untracked));
  };

  const commit = () => {
    if (!message.trim() || stagedFiles.length === 0) return;
    const text = message;
    void run("commit", async () => {
      const output = await gitCommit(cwd, text);
      // Only clear the draft once git accepted it, so a rejected commit
      // (a failing hook, an empty identity) does not lose what was typed.
      setMessage("");
      return output;
    });
  };

  /** True when the branch has no upstream yet, so push must set one. */
  const needsUpstream = status !== null && status.upstream === null;

  const openBranchMenu = (mode: BranchMode) => {
    setBranchFilter("");
    setBranchMode(mode);
    // Refetched per open: a fetch or someone else's push can have moved things.
    void gitBranchList(cwd)
      .then(setBranches)
      .catch((e) => setError(String(e)));
  };

  const branchRows = useMemo(() => {
    if (!branches) return [];
    const query = branchFilter.trim().toLowerCase();
    const all = [
      ...branches.local.map((name) => ({ name, remote: false })),
      ...branches.remote.map((name) => ({ name, remote: true })),
    ];
    return query ? all.filter((b) => b.name.toLowerCase().includes(query)) : all;
  }, [branches, branchFilter]);

  /** Offered only when the typed name is not already a branch. */
  const creatable =
    branchMode === "checkout" &&
    branchFilter.trim().length > 0 &&
    !branchRows.some((b) => b.name === branchFilter.trim());

  const pickBranch = (name: string) => {
    const mode = branchMode;
    setBranchMode(null);
    if (mode === "merge") {
      void run("merge", () => gitMerge(cwd, name));
    } else {
      void run("checkout", () => gitCheckout(cwd, name));
    }
  };

  if (error && !status) {
    return (
      <div className="sidebar-section" style={{ flex: 1 }}>
        <div className="pane-header">
          <SourceControlIcon />
          <span>Source Control</span>
        </div>
        <div className="empty-note">{error}</div>
      </div>
    );
  }

  const sectionHeader = (
    key: SectionKey,
    label: string,
    count: number | null,
    actions?: ReactNode,
  ) => (
    <div
      className="pane-header scm-group"
      style={{ height: 22 }}
      onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}
    >
      <span className="twisty">{collapsed[key] ? "▸" : "▾"}</span>
      <span className="count">
        {label}
        {count !== null && ` (${count})`}
      </span>
      {actions && (
        // Row actions live inside a clickable header, so they must not also
        // toggle the section they sit in.
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      )}
    </div>
  );

  const fileRow = (file: FileStatus, staged: boolean) => (
    <div
      key={`${staged ? "s" : "u"}:${file.path}`}
      className="row scm-row"
      title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
      onClick={() => void openFileDiff(file, staged)}
    >
      <span className="label">{file.path}</span>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        {!staged && (
          <button
            className="toggle-button icon-button"
            title="Discard changes"
            disabled={busy !== null}
            onClick={() => discard([file])}
          >
            <DiscardIcon />
          </button>
        )}
        <button
          className="toggle-button icon-button"
          title={staged ? "Unstage" : "Stage"}
          disabled={busy !== null}
          onClick={() => (staged ? unstage([file.path]) : stage([file.path]))}
        >
          {staged ? <MinusIcon /> : <PlusIcon />}
        </button>
      </div>
      <span className="status-code" data-untracked={isUntracked(file)}>
        {file.code.trim() || "·"}
      </span>
    </div>
  );

  return (
    <div className="sidebar-section" style={{ flex: 1 }}>
      <div className="pane-header">
        <SourceControlIcon />
        <span className="scm-title">Source Control</span>
        {status?.branch && (
          <button
            className="count branch-chip"
            title="Switch branch"
            disabled={busy !== null}
            onClick={() => openBranchMenu("checkout")}
          >
            <BranchIcon />
            {status.branch}
            {status.ahead > 0 && ` ↑${status.ahead}`}
            {status.behind > 0 && ` ↓${status.behind}`}
          </button>
        )}
        <div className="actions">
          <button
            className="toggle-button icon-button"
            onClick={() => void run("pull", () => gitPull(cwd))}
            disabled={busy !== null}
            title="Pull (fast-forward only)"
          >
            <PullIcon />
          </button>
          <button
            className="toggle-button icon-button"
            onClick={() => void run("push", () => gitPush(cwd, needsUpstream))}
            disabled={busy !== null}
            title={needsUpstream ? "Push and set upstream" : "Push"}
          >
            <PushIcon />
          </button>
          <button
            className="toggle-button icon-button"
            onClick={() => openBranchMenu("merge")}
            disabled={busy !== null}
            title="Merge a branch into this one"
          >
            <MergeIcon />
          </button>
          <button
            className="toggle-button icon-button"
            onClick={() => void run("fetch", () => gitFetch(cwd))}
            disabled={busy !== null}
            title="Fetch"
          >
            <FetchIcon />
          </button>
          <button
            className="toggle-button icon-button"
            onClick={() => void refresh()}
            title="Refresh"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>

      {branchMode && (
        <div className="branch-menu">
          <input
            className="branch-filter"
            autoFocus
            placeholder={branchMode === "merge" ? "Merge branch…" : "Switch to or create…"}
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setBranchMode(null);
              if (e.key === "Enter" && branchRows.length > 0) pickBranch(branchRows[0].name);
            }}
          />
          <div className="branch-list">
            {creatable && (
              <div
                className="row"
                onClick={() => {
                  const name = branchFilter.trim();
                  setBranchMode(null);
                  void run("branch", () => gitCreateBranch(cwd, name));
                }}
              >
                <PlusIcon />
                <span className="label">Create branch “{branchFilter.trim()}”</span>
              </div>
            )}
            {branchRows.map((branch) => (
              <div
                key={branch.name}
                className="row"
                data-selected={branch.name === branches?.current}
                onClick={() => pickBranch(branch.name)}
              >
                <BranchIcon />
                <span className="label">{branch.name}</span>
                {branch.remote && <span className="badge">remote</span>}
              </div>
            ))}
            {branchRows.length === 0 && !creatable && (
              <div className="empty-note">No matching branch.</div>
            )}
          </div>
        </div>
      )}

      <div className="commit-box">
        <textarea
          className="commit-message"
          rows={2}
          placeholder={
            stagedFiles.length > 0
              ? `Message (Ctrl+Enter to commit ${stagedFiles.length} staged)`
              : "Message (stage changes to commit)"
          }
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              commit();
            }
          }}
        />
        <button
          className="toggle-button commit-button"
          disabled={busy !== null || !message.trim() || stagedFiles.length === 0}
          title={
            stagedFiles.length === 0
              ? "Nothing staged"
              : `Commit ${stagedFiles.length} staged file(s)`
          }
          onClick={commit}
        >
          <CheckIcon />
          Commit{stagedFiles.length > 0 ? ` (${stagedFiles.length})` : ""}
        </button>
      </div>

      {busy && <div className="git-note">{busy}…</div>}
      {error && <div className="git-note" data-error="true">{error}</div>}
      {note && !busy && !error && <div className="git-note">{note}</div>}

      <div className="pane-body">
        {stagedFiles.length > 0 && (
          <>
            {sectionHeader(
              "staged",
              "Staged Changes",
              stagedFiles.length,
              <button
                className="toggle-button icon-button"
                title="Unstage all"
                disabled={busy !== null}
                onClick={() => unstage(stagedFiles.map((f) => f.path))}
              >
                <MinusIcon />
              </button>,
            )}
            {!collapsed.staged && stagedFiles.map((file) => fileRow(file, true))}
          </>
        )}

        {changedFiles.length > 0 && (
          <>
            {sectionHeader(
              "changes",
              "Changes",
              changedFiles.length,
              <>
                <button
                  className="toggle-button icon-button"
                  title="Discard all changes"
                  disabled={busy !== null}
                  onClick={() => discard(changedFiles)}
                >
                  <DiscardIcon />
                </button>
                <button
                  className="toggle-button icon-button"
                  title="Stage all changes"
                  disabled={busy !== null}
                  onClick={() => stage(changedFiles.map((f) => f.path))}
                >
                  <PlusIcon />
                </button>
              </>,
            )}
            {!collapsed.changes && changedFiles.map((file) => fileRow(file, false))}
          </>
        )}

        {status && status.files.length === 0 && (
          <div className="empty-note">No changes.</div>
        )}

        {sectionHeader("history", "History", null)}
        {!collapsed.history &&
          commits.map((commit) => (
            <div
              key={commit.sha}
              className="commit-row"
              data-selected={selected === commit.sha}
              onClick={() => void openCommit(commit)}
              title={`${commit.sha}\n${commit.author} <${commit.authorEmail}>`}
            >
              <CommitIcon className="commit-node" />
              <span className="sha">{commit.shortSha}</span>
              {commit.refs.slice(0, 2).map((ref) => (
                <span key={ref} className="ref-chip" data-head={ref.startsWith("HEAD")}>
                  {ref.replace("HEAD -> ", "")}
                </span>
              ))}
              <span className="subject">{commit.subject}</span>
              <span className="when">{relativeAge(commit.timestamp)}</span>
            </div>
          ))}
        {!collapsed.history && commits.length === 0 && (
          <div className="empty-note">No commits.</div>
        )}
      </div>
    </div>
  );
});
