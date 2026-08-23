import { memo, useCallback, useEffect, useState } from "react";
import { listDir } from "../lib/ipc";
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
      <div className="pane-header">
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
      <div className="pane-body">
        {error && <div className="empty-note">{error}</div>}
        {!error && !children[root] && <div className="empty-note">Loading…</div>}
        {renderLevel(root, 0)}
      </div>
    </div>
  );
});
