import { memo, useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../lib/editing";
import { fileGlyph } from "../lib/fileIcons";
import { listDir, openInDefaultApp, revealPath } from "../lib/ipc";
import { ChevronRightIcon, CollapseAllIcon, FilesIcon, RefreshIcon } from "../lib/icons";
import { useMenu, type MenuEntry } from "../lib/menu";
import { baseName, relativePath } from "../lib/paths";
import type { DirEntryInfo } from "../lib/types";

interface FileTreeProps {
  root: string;
  onOpenFile: (path: string) => void;
  selectedPath: string | null;
}

/*
 * Row geometry. `GUIDE_BASE` is the chevron's own centre: an indent guide that
 * lands anywhere else reads as belonging to the wrong level.
 */
const INDENT_BASE = 8;
const INDENT_STEP = 12;
const GUIDE_BASE = INDENT_BASE + 6;

/** Children keyed by directory path. A missing key means "not loaded yet". */
type ChildrenCache = Record<string, DirEntryInfo[]>;

/**
 * Lazy file tree.
 *
 * Directories load on first expand and stay cached, so collapsing and
 * re-expanding a large tree costs nothing. A repo like `node_modules` is never
 * walked unless the user actually opens it.
 */
export const FileTree = memo(function FileTree({ root, onOpenFile, selectedPath }: FileTreeProps) {
  const menu = useMenu();
  const [children, setChildren] = useState<ChildrenCache>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const load = useCallback(
    async (path: string) => {
      try {
        const entries = await listDir(path, true, showHidden);
        setChildren((current) => ({ ...current, [path]: entries }));
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    },
    [showHidden],
  );

  /** What is expanded, for the reload below, which must not re-run per toggle. */
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // The hidden-file filter changes what every directory contains, so its cache
  // cannot survive the toggle.
  useEffect(() => {
    setChildren({});
    setExpanded(new Set());
  }, [showHidden]);

  /*
   * A repo switch keeps the cache and re-reads over the top of it.
   *
   * Every key here is an absolute path, so one repo's rows cannot be mistaken
   * for another's, and coming back to a repo shows the tree — expansions and all
   * — that it had rather than a "Loading…" the switch has to wait out. What was
   * open is re-read too: a directory that changed while you were away would
   * otherwise sit stale until someone collapsed it.
   */
  useEffect(() => {
    if (!root) return;
    void load(root);
    for (const path of expandedRef.current) {
      if (path !== root && path.startsWith(`${root}/`)) void load(path);
    }
  }, [root, load]);

  const toggle = useCallback(
    (path: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          if (!children[path]) void load(path);
        }
        return next;
      });
    },
    [children, load],
  );

  /** The block every tree menu ends with: what the pane itself can do. */
  const paneEntries = useCallback(
    (): MenuEntry[] => [
      { label: "Refresh", run: () => void load(root) },
      { label: "Show Dotfiles", checked: showHidden, run: () => setShowHidden((v) => !v) },
      {
        label: "Collapse All",
        disabled: expanded.size === 0,
        run: () => setExpanded(new Set()),
      },
      "separator",
      { label: "Copy Repository Path", run: () => void copyText(root) },
      { label: "Reveal Repository", run: () => void revealPath(root) },
    ],
    [load, root, showHidden, expanded.size],
  );

  /** Right-click on a row. Nothing here mutates the tree — only reads it. */
  const entryMenu = useCallback(
    (entry: DirEntryInfo): MenuEntry[] => [
      { header: baseName(entry.path) },
      entry.isDir
        ? {
            label: expanded.has(entry.path) ? "Collapse" : "Expand",
            run: () => toggle(entry.path),
          }
        : { label: "Open", run: () => onOpenFile(entry.path) },
      // The way out for a file this window has no view for — a PDF, a
      // spreadsheet, a video. The binary pane offers the same thing, but a file
      // nobody wants to open in a tab should not need one opened first.
      !entry.isDir && {
        label: "Open Externally",
        run: () => void openInDefaultApp(entry.path),
      },
      entry.isDir && { label: "Refresh", run: () => void load(entry.path) },
      "separator",
      { label: "Copy Path", run: () => void copyText(entry.path) },
      {
        label: "Copy Relative Path",
        run: () => void copyText(relativePath(root, entry.path)),
      },
      { label: "Copy Name", run: () => void copyText(baseName(entry.path)) },
      { label: "Reveal in File Manager", run: () => void revealPath(entry.path) },
      "separator",
      ...paneEntries(),
    ],
    [expanded, toggle, onOpenFile, load, root, paneEntries],
  );

  const renderLevel = (path: string, depth: number): React.ReactNode => {
    const entries = children[path];
    if (!entries) return null;
    return entries.map((entry) => {
      const isOpen = expanded.has(entry.path);
      const { Icon, tone } = fileGlyph(entry.name, entry.isDir, isOpen);
      return (
        <div key={entry.path}>
          <div
            className={`row tree-row ${entry.isDir ? "dir" : "file"}`}
            style={{ paddingLeft: INDENT_BASE + depth * INDENT_STEP }}
            data-selected={selectedPath === entry.path}
            onClick={() => (entry.isDir ? toggle(entry.path) : onOpenFile(entry.path))}
            onContextMenu={(event) => menu.openContextMenu(event, entryMenu(entry))}
            title={entry.path}
          >
            {/* Files keep the chevron's width so their glyph lines up under a
                sibling directory's rather than half a step to its left. */}
            <span className="twisty" data-open={isOpen}>
              {entry.isDir && <ChevronRightIcon />}
            </span>
            <span className="tree-glyph" data-tone={tone}>
              <Icon />
            </span>
            <span className="label">{entry.name}</span>
          </div>
          {entry.isDir && isOpen && (
            /* One guide per open directory, spanning exactly the rows it owns,
               drawn from the wrapper because that is the only element whose box
               already has the right top, bottom and depth. */
            <div
              className="tree-children"
              style={
                {
                  "--guide": `${GUIDE_BASE + depth * INDENT_STEP}px`,
                } as React.CSSProperties
              }
            >
              {renderLevel(entry.path, depth + 1)}
            </div>
          )}
        </div>
      );
    });
  };

  return (
    <div className="sidebar-section" style={{ flex: 1 }}>
      <div
        className="pane-header"
        onContextMenu={(event) => menu.openContextMenu(event, paneEntries())}
      >
        <FilesIcon />
        <span className="pane-title">Explorer</span>
        <div className="actions">
          <button
            className="toggle-button"
            data-active={showHidden}
            onClick={() => setShowHidden((v) => !v)}
            title="Show dotfiles"
          >
            .*
          </button>
          <button
            className="toggle-button icon-button"
            disabled={expanded.size === 0}
            onClick={() => setExpanded(new Set())}
            title="Collapse all"
          >
            <CollapseAllIcon />
          </button>
          <button
            className="toggle-button icon-button"
            onClick={() => void load(root)}
            title="Refresh"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>
      <div
        className="pane-body"
        onContextMenu={(event) => menu.openContextMenu(event, [...paneEntries(), "separator", "app"])}
      >
        {error && <div className="empty-note">{error}</div>}
        {!error && !children[root] && <div className="empty-note">Loading…</div>}
        {renderLevel(root, 0)}
      </div>
    </div>
  );
});
