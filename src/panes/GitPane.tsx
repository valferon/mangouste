import { memo, useCallback, useEffect, useRef, useState } from "react";
import { gitDiffFile, gitLog, gitShow, gitStatus } from "../lib/ipc";
import { BranchIcon, CommitIcon, RefreshIcon, SourceControlIcon } from "../lib/icons";
import type { Commit, FileStatus, RepoStatus } from "../lib/types";

interface GitPaneProps {
  cwd: string;
  onShowDiff: (title: string, patch: string) => void;
}

const COMMIT_PAGE = 150;

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

/**
 * Working-tree status plus commit history for the active repo.
 *
 * History is a flat list rather than a rendered lane graph; the `parents` and
 * `refs` fields are already carried through from Rust for when that lands.
 */
export const GitPane = memo(function GitPane({ cwd, onShowDiff }: GitPaneProps) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const openFileDiff = useCallback(
    async (file: FileStatus) => {
      try {
        // Untracked files have no diff to show; fall back to the staged/worktree patch.
        const patch = await gitDiffFile(cwd, file.path, file.staged && !file.unstaged);
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

  if (error) {
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

  return (
    <div className="sidebar-section" style={{ flex: 1 }}>
      <div className="pane-header">
        <SourceControlIcon />
        <span>Source Control</span>
        {status?.branch && (
          <span className="count branch-chip">
            <BranchIcon />
            {status.branch}
            {status.ahead > 0 && ` ↑${status.ahead}`}
            {status.behind > 0 && ` ↓${status.behind}`}
          </span>
        )}
        <div className="actions">
          <button
            className="toggle-button icon-button"
            onClick={() => void refresh()}
            title="Refresh"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>
      <div className="pane-body">
        {status && status.files.length > 0 && (
          <>
            <div className="pane-header" style={{ height: 22 }}>
              <span className="count">Changes ({status.files.length})</span>
            </div>
            {status.files.map((file) => (
              <div
                key={file.path}
                className="row"
                title={file.path}
                onClick={() => void openFileDiff(file)}
              >
                <span className="status-code" data-untracked={file.code === "??"}>
                  {file.code.trim() || "·"}
                </span>
                <span className="label">{file.path}</span>
              </div>
            ))}
          </>
        )}

        <div className="pane-header" style={{ height: 22 }}>
          <span className="count">History</span>
        </div>
        {commits.map((commit) => (
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
        {commits.length === 0 && <div className="empty-note">No commits.</div>}
      </div>
    </div>
  );
});
