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
  gitMerge,
  gitPull,
  gitPush,
  gitStage,
  gitStatus,
  gitUnstage,
  revealPath,
} from "../lib/ipc";
import { fileGlyph } from "../lib/fileIcons";
import { baseName, parentDir } from "../lib/paths";
import { scmStatus } from "../lib/scmStatus";
import {
  BranchIcon,
  CheckIcon,
  DiscardIcon,
  MinusIcon,
  OverflowIcon,
  PlusIcon,
  PullIcon,
  PushIcon,
  RefreshIcon,
  SourceControlIcon,
} from "../lib/icons";
import { copyText } from "../lib/editing";
import { CHORD } from "../lib/keybindings";
import { useMenu, type MenuEntry } from "../lib/menu";
import type { BranchList, FileStatus, PullOutcome, RepoStatus } from "../lib/types";

interface GitPaneProps {
  cwd: string;
  onShowDiff: (title: string, patch: string) => void;
  /** Open the working-tree copy of a path in an editor tab. */
  onOpenFile: (path: string) => void;
  /**
   * A pull landed, with the commits it brought in.
   *
   * The pane says *that* it pulled; what arrived is a list of commits with
   * messages and patches, which belongs in a tab rather than in a note under
   * the header. Optional: a host with nowhere to open one leaves it out, and
   * the pull is unaffected.
   */
  onPulled?: (outcome: PullOutcome) => void;
  /**
   * Bumped when something outside this pane wrote to the repo.
   *
   * The pane re-reads after each of its own operations, so this covers the ones
   * it cannot see — a pull from the status bar — where the alternative is a
   * change list describing a worktree that has moved on.
   */
  refreshToken?: number;
  /**
   * This pane moved something other views of the repo show: a commit, a push,
   * a pull, a branch switch.
   *
   * The status bar's chip polls refs on its own clock, so without this it went
   * on saying `↑1` for a push the pane had just made. The host bumps
   * `refreshToken` in answer, which is also how this pane re-reads after one.
   */
  onChanged?: () => void;
  /**
   * Whether this sidebar view is the one on screen.
   *
   * The views are switched with `display: none`, so a hidden pane is a mounted
   * pane: without this it would keep its timers running and walk the worktree
   * for something nobody can see, and — worse — switching *to* it would not
   * re-read anything, because nothing remounted.
   */
  visible?: boolean;
}

/**
 * How often an open Source Control pane re-reads the repo.
 *
 * `refresh` is a `git status` — which walks every tracked file — plus a `git
 * log`, so this is the expensive read, not the cheap one the status bar polls.
 * What makes the rate affordable is that it only runs while the pane is the
 * sidebar view on screen: hidden, it costs nothing at all.
 */
const VISIBLE_REFRESH_MS = 10_000;

/**
 * Operations that only touch the index, which nothing outside this pane shows
 * closely enough to be told about. Everything else moves a ref or the worktree.
 */
const INDEX_ONLY = new Set(["stage", "unstage"]);

/** Which sections are open. Both follow VSCode and start expanded. */
type SectionKey = "staged" | "changes";

/** What the branch popover is about to do with the branch you pick. */
type BranchMode = "checkout" | "merge";

/** A porcelain code with no index letter and a `?` is an untracked path. */
function isUntracked(file: FileStatus): boolean {
  return file.code.trim() === "??";
}

/**
 * Working-tree status, staging, commit, sync and branch operations for the
 * active repo.
 *
 * Laid out like the VSCode SCM view: the commit box on top, then staged and
 * unstaged changes as separate collapsible groups. Every mutating
 * call goes through `run`, which serialises the operations, surfaces git's own
 * error text and re-reads status afterwards — git is the single source of truth
 * here, so nothing is optimistically applied to local state.
 *
 * What landed, and when, is not here at all: that is Git History, one button
 * down the activity rail. A second commit list in a 300px column, showing the
 * same shas that view shows with its graph, was two places to look for one
 * answer — and it pushed the change lists this pane exists for off the top.
 */
export const GitPane = memo(function GitPane({
  cwd,
  onShowDiff,
  onOpenFile,
  onPulled,
  onChanged,
  refreshToken = 0,
  visible = true,
}: GitPaneProps) {
  const menu = useMenu();
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Last successful git output worth showing, e.g. what a push did. */
  const [note, setNote] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>({
    staged: false,
    changes: false,
  });
  const [branchMode, setBranchMode] = useState<BranchMode | null>(null);
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [branchFilter, setBranchFilter] = useState("");

  /** The repo on screen now, for async work started under an earlier one. */
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  /** Bumped per refresh, so a slow scan for the previous cwd is dropped. */
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async () => {
    if (!cwd) return;
    const generation = (refreshGeneration.current += 1);
    try {
      const nextStatus = await gitStatus(cwd);
      if (generation !== refreshGeneration.current) return;
      setStatus(nextStatus);
      setError(null);
    } catch (e) {
      if (generation !== refreshGeneration.current) return;
      setError(String(e));
      setStatus(null);
    }
  }, [cwd]);

  /*
   * Every automatic read, and all of them gated on being on screen.
   *
   * Covers becoming visible, a repo switch, and `refreshToken`; the listener and
   * the timer cover the rest. `refreshToken` is a dep and nothing reads its
   * value — a bump is the whole signal.
   *
   * The pane used to re-read on those first three and nothing else, which
   * assumed what its own docstring says: that every write comes through `run`.
   * That held when the sidebar was the only way to commit. It stopped holding
   * once a session could run `git` in a terminal tab, and it does not hold at
   * all when the writer is a `claude` outside the app — the case where the pane
   * sat on a three-hour-old snapshot and reported changes that were long since
   * committed.
   */
  useEffect(() => {
    if (!visible) return;
    void refresh();
    // Coming back to the window is the moment a stale list is most likely and
    // most misleading — the same reason `Viewer` re-reads its buffer on focus.
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    // A watcher on the repo would be better than a clock, and is what VSCode
    // does. Until there is one, this is bounded by the thing that makes it
    // affordable: it only ticks while you are looking at the pane.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, VISIBLE_REFRESH_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [visible, refresh, refreshToken]);

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
      const started = cwd;
      setBusy(label);
      setError(null);
      setNote(null);
      // Told even when the action fails: a commit-and-push whose push is
      // rejected has still committed.
      const announce = onChanged !== undefined && !INDEX_ONLY.has(label);
      try {
        const output = await action();
        // A write that lands after a repo switch says nothing about this repo.
        if (cwdRef.current !== started) return;
        if (typeof output === "string" && output.trim()) setNote(output.trim());
      } catch (e) {
        if (cwdRef.current === started) setError(String(e));
      } finally {
        setBusy(null);
        // `refresh` here is bound to `started`; the new repo reads its own.
        // An announced write re-reads through `refreshToken` instead, so the
        // worktree is walked once rather than twice.
        if (cwdRef.current === started) {
          if (announce) onChanged();
          else await refresh();
        }
      }
    },
    [cwd, refresh, onChanged],
  );

  /** Pull, then hand the review upstairs. git's output still shows as a note. */
  const pull = useCallback(
    () =>
      run("pull", async () => {
        const outcome = await gitPull(cwd);
        onPulled?.(outcome);
        return outcome.output;
      }),
    [run, cwd, onPulled],
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

  /** True when the branch has no upstream yet, so push must set one. */
  const needsUpstream = status !== null && status.upstream === null;

  const canCommit = busy === null && message.trim() !== "" && stagedFiles.length > 0;

  /**
   * Commit what is staged, and with `push`, push it straight after.
   *
   * The push only runs once the commit landed, and a rejected push leaves the
   * commit in place: git's refusal shows, and the ↑ count says what is left.
   */
  const commit = (push = false) => {
    if (!message.trim() || stagedFiles.length === 0) return;
    const text = message;
    const upstream = needsUpstream;
    void run(push ? "commit & push" : "commit", async () => {
      const output = await gitCommit(cwd, text);
      // Only clear the draft once git accepted it, so a rejected commit
      // (a failing hook, an empty identity) does not lose what was typed.
      // And only this repo's draft: one typed after a switch is someone else's.
      if (cwdRef.current === cwd) setMessage("");
      if (!push) return output;
      const pushed = await gitPush(cwd, upstream);
      return [output, pushed].filter((part) => part?.trim()).join("\n\n");
    });
  };

  const openBranchMenu = (mode: BranchMode) => {
    setBranchFilter("");
    setBranchMode(mode);
    // Refetched per open: a fetch or someone else's push can have moved things.
    const asked = cwd;
    void gitBranchList(asked)
      .then((next) => {
        if (cwdRef.current === asked) setBranches(next);
      })
      .catch((e) => {
        if (cwdRef.current === asked) setError(String(e));
      });
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

  /** The repo-wide block, shared by the header, the body and the rows. */
  const repoEntries = useCallback(
    (): MenuEntry[] => [
      { label: "Refresh", run: () => void refresh() },
      "separator",
      { label: "Pull", disabled: busy !== null, run: () => void pull() },
      {
        label: status !== null && status.upstream === null ? "Push and Set Upstream" : "Push",
        disabled: busy !== null,
        run: () => void run("push", () => gitPush(cwd, status !== null && status.upstream === null)),
      },
      {
        label: "Fetch",
        disabled: busy !== null,
        run: () => void run("fetch", () => gitFetch(cwd)),
      },
      "separator",
      { label: "Switch Branch…", disabled: busy !== null, run: () => openBranchMenu("checkout") },
      { label: "Merge Branch…", disabled: busy !== null, run: () => openBranchMenu("merge") },
      "separator",
      status?.branch && {
        label: "Copy Branch Name",
        run: () => void copyText(status.branch ?? ""),
      },
      { label: "Copy Repository Path", run: () => void copyText(cwd) },
    ],
    [refresh, busy, cwd, status, run, pull, openBranchMenu],
  );

  const fileMenu = useCallback(
    (file: FileStatus, staged: boolean): MenuEntry[] => {
      const absolute = `${cwd}/${file.path}`;
      return [
        { header: file.path },
        {
          label: staged ? "Open Staged Diff" : "Open Diff",
          run: () => void openFileDiff(file, staged),
        },
        { label: "Open File", run: () => onOpenFile(absolute) },
        "separator",
        staged
          ? { label: "Unstage", disabled: busy !== null, run: () => unstage([file.path]) }
          : { label: "Stage", disabled: busy !== null, run: () => stage([file.path]) },
        !staged && {
          label: isUntracked(file) ? "Delete Untracked File" : "Discard Changes",
          danger: true,
          disabled: busy !== null,
          run: () => discard([file]),
        },
        "separator",
        { label: "Copy Path", run: () => void copyText(absolute) },
        { label: "Copy Relative Path", run: () => void copyText(file.path) },
        { label: "Reveal in File Manager", run: () => void revealPath(absolute) },
        "separator",
        ...repoEntries(),
      ];
    },
    [cwd, openFileDiff, onOpenFile, busy, stage, unstage, discard, repoEntries],
  );

  /** Right-click on a group header: the bulk operations for that group. */
  const sectionMenu = useCallback(
    (key: SectionKey): MenuEntry[] => [
      key === "staged" && {
        label: "Unstage All",
        disabled: busy !== null || stagedFiles.length === 0,
        run: () => unstage(stagedFiles.map((file) => file.path)),
      },
      key === "changes" && {
        label: "Stage All Changes",
        disabled: busy !== null || changedFiles.length === 0,
        run: () => stage(changedFiles.map((file) => file.path)),
      },
      key === "changes" && {
        label: "Discard All Changes",
        danger: true,
        disabled: busy !== null || changedFiles.length === 0,
        run: () => discard(changedFiles),
      },
      "separator",
      {
        label: collapsed[key] ? "Expand" : "Collapse",
        run: () => setCollapsed((current) => ({ ...current, [key]: !current[key] })),
      },
      "separator",
      ...repoEntries(),
    ],
    [busy, stagedFiles, changedFiles, stage, unstage, discard, collapsed, repoEntries],
  );

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
      onContextMenu={(event) => menu.openContextMenu(event, sectionMenu(key))}
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

  const fileRow = (file: FileStatus, staged: boolean) => {
    const { letter, tone, title } = scmStatus(file.code);
    const { Icon, tone: fileTone } = fileGlyph(baseName(file.path));
    const folder = parentDir(file.path);
    const moved = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
    return (
    <div
      key={`${staged ? "s" : "u"}:${file.path}`}
      className="row scm-row"
      data-tone={tone}
      title={`${title} — ${moved}`}
      onClick={() => void openFileDiff(file, staged)}
      onContextMenu={(event) => menu.openContextMenu(event, fileMenu(file, staged))}
    >
      <span className="tree-glyph" data-tone={fileTone}>
        <Icon />
      </span>
      {/* Name first and directory after it, dimmed: a column of full paths
          truncates from the right, which eats exactly the filename you were
          scanning for. */}
      <span className="label">{baseName(file.path)}</span>
      {folder && folder !== file.path && <span className="scm-dir">{folder}</span>}
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
      <span className="status-code">{letter}</span>
    </div>
    );
  };

  return (
    <div className="sidebar-section" style={{ flex: 1 }}>
      <div
        className="pane-header"
        onContextMenu={(event) => menu.openContextMenu(event, repoEntries())}
      >
        <SourceControlIcon />
        <span className="pane-title">Source Control</span>
        <div className="actions">
          <button
            className="toggle-button icon-button"
            onClick={() => void pull()}
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
            onClick={() => void refresh()}
            title="Refresh"
          >
            <RefreshIcon />
          </button>
          {/* Fetch and Merge used to sit here as buttons of their own, and five
              actions plus a title do not fit a 250px pane — the header clipped
              to "SOURCE CO…". Nothing was dropped: this opens the same list the
              header's right-click always did. */}
          <button
            className="toggle-button icon-button"
            title="More git actions"
            onClick={(event) => {
              const at = event.currentTarget.getBoundingClientRect();
              menu.openMenu({ items: repoEntries(), x: at.left, y: at.bottom + 2 });
            }}
          >
            <OverflowIcon />
          </button>
        </div>
      </div>

      {/* The branch gets its own row rather than a slot in the header. Sharing
          one 26px line with a title and five buttons is what clipped the pane
          to "SOURCE CO…" and the branch to two letters — and the branch name is
          the one thing here whose tail (`…/fix-scroll`) carries the meaning. */}
      {status?.branch && (
        <div className="branch-bar">
          <button
            className="branch-chip"
            title="Switch branch"
            disabled={busy !== null}
            onClick={() => openBranchMenu("checkout")}
          >
            <BranchIcon />
            <span className="branch-name">{status.branch}</span>
          </button>
          {(status.ahead > 0 || status.behind > 0) && (
            <span className="branch-track">
              {status.ahead > 0 && <span title="Commits to push">↑{status.ahead}</span>}
              {status.behind > 0 && <span title="Commits to pull">↓{status.behind}</span>}
            </span>
          )}
        </div>
      )}

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

      <div
        className="commit-box"
        onContextMenu={(event) =>
          menu.openContextMenu(event, [
            {
              label: `Commit${stagedFiles.length > 0 ? ` (${stagedFiles.length})` : ""}`,
              accelerator: CHORD.commit,
              disabled: !canCommit,
              run: () => commit(),
            },
            {
              label: needsUpstream ? "Commit & Push (Set Upstream)" : "Commit & Push",
              accelerator: CHORD.commitPush,
              disabled: !canCommit,
              run: () => commit(true),
            },
            message.trim() !== "" && {
              label: "Clear Message",
              run: () => setMessage(""),
            },
            "separator",
            "editing",
          ])
        }
      >
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
              // Shift adds the push, the chord the button beside Commit runs.
              commit(e.shiftKey);
            }
          }}
        />
        <div className="commit-actions">
          <button
            className="toggle-button commit-button"
            disabled={!canCommit}
            title={
              stagedFiles.length === 0
                ? "Nothing staged"
                : `Commit ${stagedFiles.length} staged file(s)`
            }
            onClick={() => commit()}
          >
            <CheckIcon />
            Commit{stagedFiles.length > 0 ? ` (${stagedFiles.length})` : ""}
          </button>
          <button
            className="toggle-button commit-button"
            disabled={!canCommit}
            title={
              stagedFiles.length === 0
                ? "Nothing staged"
                : needsUpstream
                  ? "Commit, then push and set upstream"
                  : "Commit, then push"
            }
            onClick={() => commit(true)}
          >
            <PushIcon />
            Commit &amp; Push
          </button>
        </div>
      </div>

      {busy && <div className="git-note">{busy}…</div>}
      {error && <div className="git-note" data-error="true">{error}</div>}
      {note && !busy && !error && <div className="git-note">{note}</div>}

      <div
        className="pane-body"
        onContextMenu={(event) =>
          menu.openContextMenu(event, [...repoEntries(), "separator", "app"])
        }
      >
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
      </div>
    </div>
  );
});
