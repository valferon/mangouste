import { memo, useCallback, useEffect, useState } from "react";
import { copyText } from "../lib/editing";
import { listDir, revealPath } from "../lib/ipc";
import { useMenu, type MenuEntry } from "../lib/menu";
import { baseName, relativePath } from "../lib/paths";
import type { DirEntryInfo } from "../lib/types";

interface FileTreeProps {
  root: string;
  onOpenFile: (path: string) => void;
  selectedPath: string | null;
}

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

  // Reload from scratch whenever the repo or the hidden-file filter changes.
  useEffect(() => {
    setChildren({});
    setExpanded(new Set());
    if (root) void load(root);
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
      return (
        <div key={entry.path}>
          <div
            className={`row ${entry.isDir ? "dir" : "file"}`}
            style={{ paddingLeft: 8 + depth * 12 }}
            data-selected={selectedPath === entry.path}
            onClick={() => (entry.isDir ? toggle(entry.path) : onOpenFile(entry.path))}
            onContextMenu={(event) => menu.openContextMenu(event, entryMenu(entry))}
            title={entry.path}
          >
            <span className="twisty">{entry.isDir ? (isOpen ? "▾" : "▸") : ""}</span>
            <span className="label">{entry.name}</span>
          </div>
          {entry.isDir && isOpen && renderLevel(entry.path, depth + 1)}
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
        <span>Explorer</span>
        <div className="actions">
          <button
            className="toggle-button"
            data-active={showHidden}
            onClick={() => setShowHidden((v) => !v)}
            title="Show dotfiles"
          >
            .*
          </button>
          <button className="toggle-button" onClick={() => void load(root)} title="Refresh">
            ⟳
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
