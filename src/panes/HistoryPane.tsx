import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { copyText } from "../lib/editing";
import { layoutGraph, type GraphEdge, type GraphRow } from "../lib/graph";
import { ClearIcon, ExpandIcon, HistoryIcon, RefreshIcon } from "../lib/icons";
import { gitBranchList, gitCommitDetail, gitLog, gitShow, gitShowFile, revealPath } from "../lib/ipc";
import { useMenu, type MenuEntry } from "../lib/menu";
import { baseName, parentDir } from "../lib/paths";
import type { BranchList, Commit, CommitDetail, CommitFile, LogFilter } from "../lib/types";

interface HistoryPaneProps {
  cwd: string;
  /**
   * Which shape to take.
   *
   * `sidebar` is ~300px of rail view: the filter boxes wrap, the author column
   * goes, and the commit detail sits *under* the list instead of beside it.
   * `tab` is the full width of the centre pane, two columns. A prop and not a
   * container query — the two layouts differ in what they show, not only in how
   * it is arranged, and this way the choice is one the caller can be read to
   * make.
   */
  layout?: "sidebar" | "tab";
  /** Open a patch in a tab of its own. */
  onShowDiff: (title: string, patch: string) => void;
  /** Open the working-tree copy of a path in an editor tab. */
  onOpenFile: (path: string) => void;
  /** Open the same history as a full-width tab. Sidebar layout only. */
  onOpenInTab?: () => void;
  /**
   * Bumped when something outside this pane wrote to the repo — a commit from
   * the sidebar, a pull from the status bar — so the list is not left
   * describing a HEAD that has moved on.
   */
  refreshToken?: number;
  /**
   * Whether this tab is the one on screen. History tabs stay mounted while
   * hidden, the same as file tabs, so that a page loaded, a filter typed and a
   * commit selected all survive a switch to a chat and back. What must not
   * survive is the reading: a hidden pane runs no git.
   */
  visible?: boolean;
}

/** Commits per request. A page rather than the lot: a big repo has millions. */
const PAGE = 200;

/** Keystrokes settle before a filter re-runs the log. */
const DEBOUNCE_MS = 250;

/** Row height in px. Must match `.history-row` in the stylesheet: the graph is
 *  drawn to it, and a row taller than its SVG would break every line in two. */
const ROW_HEIGHT = 24;

/** Horizontal pitch of one graph lane. */
const LANE_WIDTH = 14;

/**
 * Lanes drawn before the column stops widening.
 *
 * A repo with forty concurrent branches would otherwise push the subject off
 * the right-hand side to draw lines nobody can follow anyway. Beyond this the
 * graph is clipped, not re-laid-out — the lane a commit is in stays the lane it
 * is in, so scrolling does not shuffle the columns.
 */
const MAX_LANES = 10;

/** Changed files rendered for one commit; the rest are counted, not listed. */
const FILE_LIMIT = 500;

/** Centre of a lane, in the graph column's own coordinates. */
const laneX = (lane: number): number => lane * LANE_WIDTH + LANE_WIDTH / 2;

/**
 * One edge as an SVG path.
 *
 * A `pass` spans the row, an `in` stops at the node's centre and an `out`
 * starts there. The curves are cubics with their control points on the vertical,
 * which is what makes a branch leave its parent as a bend rather than a corner.
 */
function edgePath(edge: GraphEdge): string {
  const mid = ROW_HEIGHT / 2;
  const from = laneX(edge.from);
  const to = laneX(edge.to);
  if (edge.kind === "pass") return `M ${from} 0 L ${to} ${ROW_HEIGHT}`;
  if (edge.kind === "in") {
    if (from === to) return `M ${from} 0 L ${to} ${mid}`;
    return `M ${from} 0 C ${from} ${mid * 0.7}, ${to} ${mid * 0.3}, ${to} ${mid}`;
  }
  if (from === to) return `M ${from} ${mid} L ${to} ${ROW_HEIGHT}`;
  return `M ${from} ${mid} C ${from} ${mid * 1.3}, ${to} ${mid * 1.7}, ${to} ${ROW_HEIGHT}`;
}

/** The lane column for one row: its lines, and its commit's node. */
const GraphCell = memo(function GraphCell({ row }: { row: GraphRow }) {
  const width = Math.min(row.lanes, MAX_LANES) * LANE_WIDTH;
  return (
    <svg
      className="graph-cell"
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      aria-hidden="true"
    >
      {row.edges.map((edge, index) => (
        <path
          key={index}
          className="graph-edge"
          d={edgePath(edge)}
          style={{ stroke: `var(--graph-${edge.color + 1})` }}
        />
      ))}
      <circle
        className="graph-node"
        cx={laneX(row.lane)}
        cy={ROW_HEIGHT / 2}
        r={3.5}
        style={{ stroke: `var(--graph-${row.color + 1})` }}
      />
    </svg>
  );
});

/**
 * Compact age — `2h`, `3d`, `1y` — matching the Source Control pane's column.
 *
 * A local copy of the same six lines that pane has: the rail view is ~300px
 * wide and a `31 Aug 14:02` stamp is 60px of it, which is the difference
 * between reading a subject and reading half of one.
 */
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

/** `31 Aug 14:02` this year, `31 Aug 2024` before it. */
function formatWhen(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const day = date.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
  return date.getFullYear() === new Date().getFullYear()
    ? `${day} ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : `${day} ${date.getFullYear()}`;
}

/** Full stamp for the detail pane and the row tooltips. */
const formatStamp = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toLocaleString();

/** git's status letter, spelled out for the column's tooltip. */
function statusName(status: string): string {
  switch (status.charAt(0)) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type changed";
    default:
      return "modified";
  }
}

/**
 * The repository's history, at the width the graph needs.
 *
 * The one commit list in the app: every commit on every branch, the lanes
 * between them, and — for the selected one — its message, its committer and the
 * files it touched, each of which opens as its own patch rather than as a slice
 * of a `git show` that had forty other files in it.
 *
 * Reads only. Nothing here rewrites history or moves a ref; committing,
 * checking out and merging stay in the Source Control pane, where the working
 * tree they act on is also on screen.
 */
export const HistoryPane = memo(function HistoryPane({
  cwd,
  layout = "tab",
  onShowDiff,
  onOpenFile,
  onOpenInTab,
  refreshToken = 0,
  visible = true,
}: HistoryPaneProps) {
  const menu = useMenu();
  const [commits, setCommits] = useState<Commit[]>([]);
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  /** What the boxes hold, and — one debounce later — what git was asked. */
  const [draft, setDraft] = useState<LogFilter>({});
  const [filter, setFilter] = useState<LogFilter>({});
  const [branch, setBranch] = useState("");

  const listRef = useRef<HTMLDivElement>(null);
  /** Discards the answer to a query a later one has already replaced. */
  const queryId = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setFilter(draft), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  // A repo switch is a different history, not a filtered one.
  useEffect(() => {
    setDraft({});
    setFilter({});
    setBranch("");
    setSelected(null);
    setDetail(null);
  }, [cwd]);

  const query = useMemo<LogFilter>(() => ({ ...filter, branch }), [filter, branch]);

  const load = useCallback(async () => {
    const id = (queryId.current += 1);
    setLoading(true);
    try {
      // `allBranches` is false when a branch is picked: the branch *is* the
      // starting point then, and `--all` would widen it straight back out.
      const page = await gitLog(cwd, PAGE, 0, branch === "", query);
      if (queryId.current !== id) return;
      setCommits(page);
      setMore(page.length === PAGE);
      setError(null);
      setSelected((current) =>
        current !== null && page.some((commit) => commit.sha === current)
          ? current
          : (page[0]?.sha ?? null),
      );
    } catch (e) {
      if (queryId.current !== id) return;
      setCommits([]);
      setMore(false);
      setError(String(e));
    } finally {
      if (queryId.current === id) setLoading(false);
    }
  }, [cwd, branch, query]);

  const loadMore = useCallback(async () => {
    const id = (queryId.current += 1);
    setLoading(true);
    try {
      const page = await gitLog(cwd, PAGE, commits.length, branch === "", query);
      if (queryId.current !== id) return;
      setCommits((current) => [...current, ...page]);
      setMore(page.length === PAGE);
    } catch (e) {
      if (queryId.current === id) setError(String(e));
    } finally {
      if (queryId.current === id) setLoading(false);
    }
  }, [cwd, branch, query, commits.length]);

  /**
   * One key per distinct query. Re-reading is keyed on the key changing rather
   * than on the effect running, so being switched to and away from a dozen
   * times costs a dozen nothings — and a filter typed while the tab was hidden
   * is still picked up the moment it comes back.
   */
  const queryKey = useMemo(
    () => JSON.stringify({ cwd, query, refreshToken, reloadToken }),
    [cwd, query, refreshToken, reloadToken],
  );
  const loadedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || cwd === "") return;
    if (loadedKey.current === queryKey) return;
    loadedKey.current = queryKey;
    void load();
  }, [visible, queryKey, cwd, load]);

  useEffect(() => {
    if (!visible || cwd === "") return;
    let live = true;
    gitBranchList(cwd)
      .then((list) => live && setBranches(list))
      .catch(() => live && setBranches(null));
    return () => {
      live = false;
    };
  }, [cwd, visible, refreshToken, reloadToken]);

  // The detail is a second git call, so it follows the selection rather than
  // riding along with the log: a page of 200 commits would otherwise be 200
  // `git show`s to render a list nobody has clicked in yet.
  useEffect(() => {
    if (!visible || selected === null) {
      if (selected === null) setDetail(null);
      return;
    }
    let live = true;
    setDetailError(null);
    gitCommitDetail(cwd, selected)
      .then((next) => {
        if (live) setDetail(next);
      })
      .catch((e) => {
        if (!live) return;
        setDetail(null);
        setDetailError(String(e));
      });
    return () => {
      live = false;
    };
  }, [cwd, selected, visible]);

  const graph = useMemo(() => layoutGraph(commits), [commits]);
  const graphWidth = useMemo(
    () => Math.min(Math.max(1, ...graph.map((row) => row.lanes)), MAX_LANES) * LANE_WIDTH,
    [graph],
  );

  const openWholePatch = useCallback(
    async (commit: Commit) => {
      try {
        onShowDiff(`${commit.shortSha} ${commit.subject}`, await gitShow(cwd, commit.sha));
      } catch (e) {
        onShowDiff(commit.shortSha, String(e));
      }
    },
    [cwd, onShowDiff],
  );

  const openFilePatch = useCallback(
    async (sha: string, shortSha: string, path: string) => {
      try {
        const patch = await gitShowFile(cwd, sha, path);
        onShowDiff(`${shortSha} ${path}`, patch || `${path}\n\n(no textual diff)`);
      } catch (e) {
        onShowDiff(`${shortSha} ${path}`, String(e));
      }
    },
    [cwd, onShowDiff],
  );

  /** Move the selection by `step` rows, keeping the new one in view. */
  const move = useCallback(
    (step: number) => {
      setSelected((current) => {
        const at = commits.findIndex((commit) => commit.sha === current);
        const next = Math.min(Math.max(at + step, 0), commits.length - 1);
        const commit = commits[next];
        if (!commit) return current;
        listRef.current
          ?.querySelector(`[data-sha="${commit.sha}"]`)
          ?.scrollIntoView({ block: "nearest" });
        return commit.sha;
      });
    },
    [commits],
  );

  const commitMenu = useCallback(
    (commit: Commit): MenuEntry[] => [
      { label: "View Whole Patch", run: () => void openWholePatch(commit) },
      "separator",
      { label: "Copy Commit Hash", run: () => void copyText(commit.sha) },
      { label: "Copy Subject", run: () => void copyText(commit.subject) },
      {
        label: "Copy Author",
        run: () => void copyText(`${commit.author} <${commit.authorEmail}>`),
      },
      "separator",
      {
        label: "Filter to this Author",
        run: () => setDraft((current) => ({ ...current, author: commit.author })),
      },
    ],
    [openWholePatch],
  );

  const fileMenu = useCallback(
    (file: CommitFile): MenuEntry[] => {
      const absolute = `${cwd}/${file.path}`;
      return [
        {
          label: "Open File",
          run: () => onOpenFile(absolute),
        },
        {
          label: "Filter History to this File",
          run: () => setDraft((current) => ({ ...current, path: file.path })),
        },
        "separator",
        { label: "Copy Path", run: () => void copyText(file.path) },
        { label: "Reveal in File Manager", run: () => void revealPath(absolute) },
      ];
    },
    [cwd, onOpenFile],
  );

  const filterBox = (
    key: "text" | "author" | "path",
    placeholder: string,
    title: string,
  ) => (
    <label className="history-filter" title={title}>
      <input
        className="history-input"
        placeholder={placeholder}
        value={draft[key] ?? ""}
        spellCheck={false}
        onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
      />
      {(draft[key] ?? "") !== "" && (
        <button
          className="icon-button history-clear"
          title={`Clear ${placeholder.toLowerCase()}`}
          onClick={() => setDraft((current) => ({ ...current, [key]: "" }))}
        >
          <ClearIcon />
        </button>
      )}
    </label>
  );

  const shown = detail?.files.slice(0, FILE_LIMIT) ?? [];
  const hidden = (detail?.files.length ?? 0) - shown.length;

  return (
    <div className="history-pane" data-layout={layout}>
      {/* The tab has the strip above it to say what it is; the rail view has
          nothing, and every other rail view has a header. */}
      {layout === "sidebar" && (
        <div className="pane-header">
          <HistoryIcon />
          <span className="pane-title">Git History</span>
          <div className="actions">
            {onOpenInTab && (
              <button
                className="toggle-button icon-button"
                title="Open this history in a full-width tab"
                onClick={onOpenInTab}
              >
                <ExpandIcon />
              </button>
            )}
            <button
              className="toggle-button icon-button"
              title="Reload history"
              disabled={loading}
              onClick={() => setReloadToken((token) => token + 1)}
            >
              <RefreshIcon />
            </button>
          </div>
        </div>
      )}
      <div className="history-filters">
        {filterBox("text", "Message", "Commits whose message contains this text")}
        {filterBox("author", "Author", "Commits by an author whose name or email contains this")}
        {filterBox("path", "Path", "Commits that touched this path, relative to the repo root")}
        <select
          className="history-branch"
          value={branch}
          title="Which refs the history is walked from"
          onChange={(event) => setBranch(event.target.value)}
        >
          <option value="">All branches</option>
          {branches?.local.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          {branches?.remote.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        {layout === "tab" && (
          <button
            className="toggle-button icon-button"
            title="Reload history"
            disabled={loading}
            onClick={() => setReloadToken((token) => token + 1)}
          >
            <RefreshIcon />
          </button>
        )}
      </div>

      <div className="history-body">
        <div
          className="history-list"
          ref={listRef}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              move(-1);
            }
          }}
        >
          {error !== null && <div className="empty-note history-error">{error}</div>}
          {error === null && commits.length === 0 && !loading && (
            <div className="empty-note">No commits match.</div>
          )}
          {commits.map((commit, index) => (
            <div
              key={commit.sha}
              className="history-row"
              data-sha={commit.sha}
              data-selected={selected === commit.sha}
              onClick={() => setSelected(commit.sha)}
              onDoubleClick={() => void openWholePatch(commit)}
              onContextMenu={(event) => {
                setSelected(commit.sha);
                menu.openContextMenu(event, commitMenu(commit));
              }}
              title={`${commit.sha}\n${commit.author} <${commit.authorEmail}>\n${formatStamp(commit.timestamp)}`}
            >
              <span className="history-graph" style={{ width: graphWidth }}>
                {graph[index] && <GraphCell row={graph[index]} />}
              </span>
              {commit.refs.map((ref) => (
                <span key={ref} className="ref-chip" data-head={ref.startsWith("HEAD")}>
                  {ref.replace("HEAD -> ", "")}
                </span>
              ))}
              <span className="subject">{commit.subject}</span>
              {layout === "tab" && <span className="history-author">{commit.author}</span>}
              <span className="sha">{commit.shortSha}</span>
              <span className="when">
                {layout === "tab" ? formatWhen(commit.timestamp) : relativeAge(commit.timestamp)}
              </span>
            </div>
          ))}
          {more && (
            <button className="history-more" disabled={loading} onClick={() => void loadMore()}>
              {loading ? "Loading…" : `Load ${PAGE} more`}
            </button>
          )}
        </div>

        <div className="history-detail">
          {detailError !== null && <div className="empty-note history-error">{detailError}</div>}
          {detail === null && detailError === null && (
            <div className="empty-note">Select a commit.</div>
          )}
          {detail !== null && (
            <>
              <div className="history-detail-head">
                <span className="sha">{detail.commit.shortSha}</span>
                {detail.commit.refs.map((ref) => (
                  <span key={ref} className="ref-chip" data-head={ref.startsWith("HEAD")}>
                    {ref.replace("HEAD -> ", "")}
                  </span>
                ))}
                <button
                  className="toggle-button"
                  title="Open every file this commit touched as one patch"
                  onClick={() => void openWholePatch(detail.commit)}
                >
                  Whole patch
                </button>
              </div>

              <div className="history-message selectable">
                <div className="history-subject">{detail.commit.subject}</div>
                {detail.body !== "" && <pre className="history-body-text">{detail.body}</pre>}
              </div>

              <div className="history-people">
                <div>
                  <span className="history-label">Author</span>
                  {detail.commit.author} &lt;{detail.commit.authorEmail}&gt;
                  <span className="when"> {formatStamp(detail.commit.timestamp)}</span>
                </div>
                {/* Only when it differs: on the overwhelming majority of
                    commits the committer is the author, and a line repeating
                    the one above it is a line spent saying nothing. */}
                {(detail.committerEmail !== detail.commit.authorEmail ||
                  detail.commitTimestamp !== detail.commit.timestamp) && (
                  <div>
                    <span className="history-label">Committer</span>
                    {detail.committer} &lt;{detail.committerEmail}&gt;
                    <span className="when"> {formatStamp(detail.commitTimestamp)}</span>
                  </div>
                )}
                {detail.commit.parents.length > 1 && (
                  <div>
                    <span className="history-label">Merge</span>
                    {detail.commit.parents.map((parent) => parent.slice(0, 8)).join(" + ")}
                  </div>
                )}
              </div>

              <div className="history-files-head">
                {detail.files.length} file{detail.files.length === 1 ? "" : "s"} changed
              </div>
              {detail.files.length === 0 && (
                <div className="empty-note">
                  Nothing, as far as the first parent is concerned.
                </div>
              )}
              {shown.map((file) => (
                <div
                  key={`${file.status}:${file.path}`}
                  className="history-file"
                  onClick={() => void openFilePatch(detail.commit.sha, detail.commit.shortSha, file.path)}
                  onContextMenu={(event) => menu.openContextMenu(event, fileMenu(file))}
                  title={`${statusName(file.status)}: ${file.originalPath ? `${file.originalPath} → ` : ""}${file.path}`}
                >
                  <span className="status-code" data-status={file.status.charAt(0)}>
                    {file.status.charAt(0)}
                  </span>
                  <span className="history-file-name">{baseName(file.path)}</span>
                  <span className="history-file-dir">{parentDir(file.path)}</span>
                  {file.additions === null ? (
                    <span className="history-binary">binary</span>
                  ) : (
                    <span className="history-counts">
                      <span className="added">+{file.additions}</span>
                      <span className="removed">−{file.deletions ?? 0}</span>
                    </span>
                  )}
                </div>
              ))}
              {hidden > 0 && (
                <div className="empty-note">
                  {hidden} more file{hidden === 1 ? "" : "s"} not listed. Open the whole patch to
                  see them.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
});
