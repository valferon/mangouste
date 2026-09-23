import { memo, useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../lib/editing";
import {
  ancestorsBetween,
  deleteWarning,
  draftPath,
  draftPrompt,
  dropTarget,
  isUnder,
  moveTarget,
  nameError,
  refreshTargets,
  repointPath,
  type DraftKind,
} from "../lib/fileOps";
import { fileGlyph } from "../lib/fileIcons";
import {
  copyPath,
  createDir,
  createFile,
  deletePath,
  duplicatePath,
  listDir,
  openInDefaultApp,
  renamePath,
  revealPath,
} from "../lib/ipc";
import {
  ChevronRightIcon,
  CollapseAllIcon,
  FilesIcon,
  NewFileIcon,
  NewFolderIcon,
  RefreshIcon,
} from "../lib/icons";
import { useMenu, type MenuEntry } from "../lib/menu";
import { baseName, parentDir, relativePath } from "../lib/paths";
import type { DirEntryInfo } from "../lib/types";

interface FileTreeProps {
  root: string;
  onOpenFile: (path: string) => void;
  selectedPath: string | null;
  /**
   * A rename or a move landed. Carries both paths because the tree does not own
   * the tabs: an open buffer over the old path has to follow it or it points at
   * a file that no longer resolves.
   */
  onPathRenamed: (from: string, to: string) => void;
  /** A delete landed, so anything open over the path — or under it — can close. */
  onPathDeleted: (path: string) => void;
  /**
   * Whether the path, or anything beneath it, has unsaved editor changes.
   *
   * The tree asks before it moves or deletes: renaming a file out from under a
   * dirty buffer would leave the editor saving to a path that is gone, and
   * there is no version of that which ends with the user's edits intact.
   */
  hasUnsavedEdits: (path: string) => boolean;
  /**
   * Bumped when something outside the tree rewrote the repo — a pull, so far.
   *
   * The tree re-reads after its own writes, so it only needs telling about the
   * ones it did not make. Without this a pull lands a hundred files and the
   * pane still shows the tree from before it.
   */
  refreshToken: number;
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
 * The one row that is an input rather than an entry.
 *
 * New names are typed in the tree instead of a modal for the reason every
 * editor does it that way: the name only makes sense next to its siblings, and
 * a dialog covers them. `target` is the entry being renamed, and null for a
 * create — the two share this state because only one can be open at a time.
 */
interface Draft {
  kind: DraftKind;
  /** Directory the entry lands in. For a rename, the target's current parent. */
  dir: string;
  target: string | null;
  value: string;
}

/** A path held for a later paste, and whether pasting should move it. */
interface Clipboard {
  path: string;
  cut: boolean;
}

/**
 * Lazy file tree.
 *
 * Directories load on first expand and stay cached, so collapsing and
 * re-expanding a large tree costs nothing. A repo like `node_modules` is never
 * walked unless the user actually opens it.
 *
 * Also where the tree is edited — create, rename, move, duplicate, delete. Each
 * of those ends by re-reading the directories it touched rather than patching
 * the cache: the backend is the only thing that knows what actually landed, and
 * a listing is one cheap call against a directory that was just written.
 */
export const FileTree = memo(function FileTree({
  root,
  onOpenFile,
  selectedPath,
  onPathRenamed,
  onPathDeleted,
  hasUnsavedEdits,
  refreshToken,
}: FileTreeProps) {
  const menu = useMenu();
  const [children, setChildren] = useState<ChildrenCache>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);

  /**
   * Newest listing issued per directory.
   *
   * Two operations touching one directory issue two `listDir` calls, and the
   * Rust side answers them on a thread pool with no ordering promise. Without a
   * sequence the slower answer to the older question wins and the tree settles
   * on a listing that matches neither write. Nothing cancels the call itself —
   * it is one directory level, already in flight — the answer is just dropped.
   */
  const listSeq = useRef(new Map<string, number>());

  /**
   * Drop a subtree from the cache, for a path that has been renamed or deleted.
   *
   * Every cache key under it is now a path that does not exist, and an expanded
   * set still holding one would have the tree try to re-read it on the next
   * repo switch.
   */
  const forget = useCallback((path: string) => {
    setChildren((current) => {
      const kept = Object.entries(current).filter(([key]) => !isUnder(key, path));
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
    });
    setExpanded((current) => {
      const kept = [...current].filter((key) => !isUnder(key, path));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, []);

  const load = useCallback(
    /**
     * `orphaned` is for the directories nobody asked about by name — a bulk
     * re-read of the cache. One of them failing means it is gone, which is a
     * fact about the tree rather than something the user did, so it is dropped
     * instead of put on screen. A directory the user pointed at still reports.
     */
    async (path: string, orphaned = false) => {
      const seq = (listSeq.current.get(path) ?? 0) + 1;
      listSeq.current.set(path, seq);
      const current = () => listSeq.current.get(path) === seq;
      try {
        const entries = await listDir(path, true, showHidden);
        if (!current()) return;
        setChildren((cache) => ({ ...cache, [path]: entries }));
        setError(null);
      } catch (e) {
        if (!current()) return;
        if (orphaned) forget(path);
        else setError(String(e));
      }
    },
    [showHidden, forget],
  );

  /** The cache, for the refresh below, which must not re-run per listing. */
  const childrenRef = useRef(children);
  childrenRef.current = children;

  /**
   * Re-read every directory the tree is holding, not just the root.
   *
   * What the root listing shows is the top level's own names, and a pull that
   * rewrites `src/lib/ipc.ts` changes none of them. Refreshing meant looking at
   * the same stale tree with the extra confidence of having asked.
   */
  const refreshAll = useCallback(() => {
    const [, ...nested] = refreshTargets(root, Object.keys(childrenRef.current));
    void load(root);
    for (const dir of nested) void load(dir, true);
  }, [load, root]);

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

  /*
   * An outside write landed, so the whole cache is suspect.
   *
   * Compared against the token last acted on rather than left to the dependency
   * list: `refreshAll` is rebuilt on a repo switch, and re-running there would
   * sweep the tree a second time behind the effect above that just read it.
   */
  const seenRefresh = useRef(refreshToken);
  useEffect(() => {
    if (seenRefresh.current === refreshToken) return;
    seenRefresh.current = refreshToken;
    refreshAll();
  }, [refreshToken, refreshAll]);

  // A draft belongs to the repo it was opened in; leaving would commit it
  // somewhere the user is no longer looking.
  useEffect(() => setDraft(null), [root]);

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

  /** Open every directory in `paths`, loading the ones not seen yet. */
  const reveal = useCallback(
    (paths: string[]) => {
      setExpanded((current) => {
        const next = new Set(current);
        for (const path of paths) next.add(path);
        return next;
      });
      for (const path of paths) void load(path);
    },
    [load],
  );

  /** Re-read directories after a write, skipping the duplicates and the blanks. */
  const reload = useCallback(
    async (...dirs: (string | null)[]) => {
      const seen = new Set(dirs.filter((dir): dir is string => Boolean(dir)));
      await Promise.all([...seen].map((dir) => load(dir)));
    },
    [load],
  );

  /**
   * Carry a cached subtree to where it was just moved.
   *
   * Cheaper than dropping it, and it is what stops a dragged directory from
   * collapsing: every key under it is still a real directory, only spelled
   * differently. The entries inside carry absolute paths of their own, so those
   * move too, or the next click would open a file by its old name.
   */
  const rekey = useCallback((from: string, to: string) => {
    const moved = (path: string) => repointPath(path, from, to) ?? path;
    setChildren((current) =>
      Object.fromEntries(
        Object.entries(current).map(([key, entries]) => [
          moved(key),
          entries.map((entry) => ({ ...entry, path: moved(entry.path) })),
        ]),
      ),
    );
    setExpanded((current) => new Set([...current].map(moved)));
  }, []);

  /** Keep a cut or copied path pointing at something that still exists. */
  const followClipboard = useCallback((from: string, to: string, consumed: boolean) => {
    setClipboard((current) => {
      if (!current || !isUnder(current.path, from)) return current;
      // A paste of a cut has spent it; a rename of one has only moved it.
      if (consumed) return null;
      const path = repointPath(current.path, from, to);
      return path === null ? null : { ...current, path };
    });
  }, []);

  /**
   * Run one mutating operation, putting whatever it refuses on screen.
   *
   * The backend's errors are the user-facing text here — "already exists",
   * "Permission denied" — because each of them names a thing the user can
   * actually go and change.
   */
  const run = useCallback(async (what: string, work: () => Promise<void>) => {
    // Cleared here rather than on success: an operation that finishes while a
    // previous one's refusal is still on screen would otherwise wipe the
    // message before it had been read.
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(`Could not ${what}: ${String(e)}`);
    }
  }, []);

  /**
   * Refuse to move or delete a path with edits still in a buffer, and say why.
   *
   * Checked here rather than left to the editor because the editor cannot
   * recover from it: once the path is gone its save has nowhere to land.
   */
  const blockedByEdits = useCallback(
    (path: string) => {
      if (!hasUnsavedEdits(path)) return false;
      setError(`Unsaved changes in ${baseName(path)} — save or close it first`);
      return true;
    },
    [hasUnsavedEdits],
  );

  /**
   * Where the header's two create buttons aim.
   *
   * The directory of whatever is selected, so "New File" after clicking into a
   * folder lands in that folder rather than at the repo root, which is almost
   * never where the next file goes.
   */
  const creationDir = useCallback(() => {
    if (selectedPath && selectedPath.startsWith(`${root}/`)) return parentDir(selectedPath);
    return root;
  }, [selectedPath, root]);

  /** Open the input row. A create needs the directory; a rename needs the entry. */
  const beginDraft = useCallback(
    (kind: DraftKind, dir: string, entry?: DirEntryInfo) => {
      if (kind === "rename" && entry) {
        if (blockedByEdits(entry.path)) return;
        setDraft({ kind, dir: parentDir(entry.path), target: entry.path, value: entry.name });
        return;
      }
      // The row has to be visible to be typed into, and the directory it lands
      // in may still be closed.
      reveal([dir]);
      setDraft({ kind, dir, target: null, value: "" });
    },
    [blockedByEdits, reveal],
  );

  const commitDraft = useCallback(() => {
    if (!draft) return;
    const problem = nameError(draft.value);
    if (problem) {
      setError(problem);
      return;
    }
    const { kind, dir, target } = draft;
    const path = draftPath(dir, draft.value);
    setDraft(null);

    if (kind === "rename" && target) {
      if (path === target) return;
      void run("rename", async () => {
        await renamePath(target, path);
        rekey(target, path);
        followClipboard(target, path, false);
        await reload(dir, parentDir(path));
        reveal(ancestorsBetween(dir, path).slice(1));
        onPathRenamed(target, path);
      });
      return;
    }

    void run(kind === "folder" ? "create the folder" : "create the file", async () => {
      if (kind === "folder") await createDir(path);
      else await createFile(path);
      await reload(dir);
      // A nested name ("api/routes/users.ts") just made directories nobody has
      // opened; without this the tree shows nothing happened.
      // A new folder is itself worth opening; a new file is not a directory.
      const chain = ancestorsBetween(dir, path);
      reveal(kind === "folder" ? [...chain, path] : chain);
      if (kind === "file") onOpenFile(path);
    });
  }, [draft, run, rekey, followClipboard, reload, reveal, onPathRenamed, onOpenFile]);

  const remove = useCallback(
    (entry: DirEntryInfo) => {
      if (blockedByEdits(entry.path)) return;
      // The confirm is the only warning: this deletes for real, with no trash
      // behind it and no undo in front of it.
      if (!window.confirm(deleteWarning(entry.path, entry.isDir))) return;
      void run("delete", async () => {
        await deletePath(entry.path);
        forget(entry.path);
        await reload(parentDir(entry.path));
        if (clipboard && isUnder(clipboard.path, entry.path)) setClipboard(null);
        onPathDeleted(entry.path);
      });
    },
    [blockedByEdits, run, forget, reload, clipboard, onPathDeleted],
  );

  const duplicate = useCallback(
    (entry: DirEntryInfo) => {
      void run("duplicate", async () => {
        const made = await duplicatePath(entry.path);
        await reload(parentDir(made));
      });
    },
    [run, reload],
  );

  /** Move an entry into a directory. Backs both the paste of a cut and a drop. */
  const move = useCallback(
    (source: string, dir: string, pasted = false) => {
      const target = moveTarget(source, dir);
      if ("error" in target) {
        // Dropping a row back where it already was is a miss, not a mistake;
        // reporting it would put an error on screen for doing nothing.
        if (target.error !== "Already there") setError(target.error);
        return;
      }
      if (blockedByEdits(source)) return;
      void run("move", async () => {
        await renamePath(source, target.path);
        rekey(source, target.path);
        // Only the paste that spent the cut clears it. An unrelated drag used
        // to cancel whatever was on the clipboard, which is a surprise nobody
        // asked for.
        followClipboard(source, target.path, pasted);
        await reload(parentDir(source), dir);
        onPathRenamed(source, target.path);
      });
    },
    [blockedByEdits, run, rekey, followClipboard, reload, onPathRenamed],
  );

  const paste = useCallback(
    (dir: string) => {
      if (!clipboard) return;
      const { path: source, cut } = clipboard;
      if (cut) {
        move(source, dir, true);
        return;
      }
      if (isUnder(dir, source)) {
        setError("Cannot copy a folder into itself");
        return;
      }
      void run("paste", async () => {
        // Pasting a copy back into its own directory is a duplicate, and the
        // backend is the side that can pick a free name without a race.
        if (parentDir(source) === dir) await duplicatePath(source);
        else await copyPath(source, `${dir}/${baseName(source)}`);
        await reload(dir);
      });
    },
    [clipboard, move, run, reload],
  );

  /** Where a drop on a row lands, and whether that row should light up for it. */
  const dropDirFor = (entry: DirEntryInfo) => dropTarget(entry.path, entry.isDir);

  const handleDrop = useCallback(
    (dir: string) => {
      const source = dragPath;
      setDragPath(null);
      setDropDir(null);
      if (source) move(source, dir);
    },
    [dragPath, move],
  );

  /** The block every tree menu ends with: what the pane itself can do. */
  const paneEntries = useCallback(
    (): MenuEntry[] => [
      { label: "New File…", run: () => beginDraft("file", creationDir()) },
      { label: "New Folder…", run: () => beginDraft("folder", creationDir()) },
      {
        label: "Paste",
        disabled: !clipboard,
        run: () => paste(creationDir()),
      },
      "separator",
      { label: "Refresh", run: refreshAll },
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
    [beginDraft, creationDir, clipboard, paste, refreshAll, root, showHidden, expanded.size],
  );

  /** Right-click on a row. */
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
      // A create aimed at a file row means "beside this one", which is what its
      // own directory is. Nobody right-clicks a file to mean "inside it".
      {
        label: "New File…",
        run: () => beginDraft("file", dropDirFor(entry)),
      },
      {
        label: "New Folder…",
        run: () => beginDraft("folder", dropDirFor(entry)),
      },
      "separator",
      { label: "Rename…", run: () => beginDraft("rename", parentDir(entry.path), entry) },
      { label: "Duplicate", run: () => duplicate(entry) },
      { label: "Cut", run: () => setClipboard({ path: entry.path, cut: true }) },
      { label: "Copy", run: () => setClipboard({ path: entry.path, cut: false }) },
      {
        label: "Paste",
        disabled: !clipboard,
        run: () => paste(dropDirFor(entry)),
      },
      { label: "Delete", run: () => remove(entry) },
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
    [
      expanded,
      toggle,
      onOpenFile,
      load,
      root,
      paneEntries,
      beginDraft,
      duplicate,
      clipboard,
      paste,
      remove,
    ],
  );

  /**
   * The input row, rendered in the level it will create into.
   *
   * Enter commits and Escape cancels. A click away cancels too, rather than
   * committing what is half-typed: a stray click creating a file called `use`
   * is worse than losing three keystrokes.
   */
  const renderDraft = (depth: number) => {
    if (!draft) return null;
    return (
      <div className="row tree-row tree-draft" style={{ paddingLeft: INDENT_BASE + depth * INDENT_STEP }}>
        <span className="twisty" />
        <input
          className="tree-draft-input"
          autoFocus
          spellCheck={false}
          value={draft.value}
          placeholder={draftPrompt(draft.kind)}
          onChange={(event) =>
            setDraft((current) => (current ? { ...current, value: event.target.value } : current))
          }
          onFocus={(event) => event.currentTarget.select()}
          onBlur={() => setDraft(null)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitDraft();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft(null);
            }
          }}
        />
      </div>
    );
  };

  const renderLevel = (path: string, depth: number): React.ReactNode => {
    const entries = children[path];
    if (!entries) return null;
    const creating = draft && draft.target === null && draft.dir === path;
    return (
      <>
        {creating && renderDraft(depth)}
        {entries.map((entry) => {
          const isOpen = expanded.has(entry.path);
          const { Icon, tone } = fileGlyph(entry.name, entry.isDir, isOpen);
          if (draft?.target === entry.path) return <div key={entry.path}>{renderDraft(depth)}</div>;
          return (
            <div key={entry.path}>
              <div
                className={`row tree-row ${entry.isDir ? "dir" : "file"}`}
                style={{ paddingLeft: INDENT_BASE + depth * INDENT_STEP }}
                data-selected={selectedPath === entry.path}
                data-cut={Boolean(clipboard?.cut) && isUnder(entry.path, clipboard?.path ?? "")}
                data-drop={Boolean(dragPath) && dropDir === entry.path && entry.isDir}
                onClick={() => (entry.isDir ? toggle(entry.path) : onOpenFile(entry.path))}
                onContextMenu={(event) => menu.openContextMenu(event, entryMenu(entry))}
                title={entry.path}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  // Set for the drop handler's sake on platforms that clear the
                  // drag on a re-render; the state is what the app reads.
                  event.dataTransfer.setData("text/plain", entry.path);
                  setDragPath(entry.path);
                }}
                onDragEnd={() => {
                  setDragPath(null);
                  setDropDir(null);
                }}
                onDragOver={(event) => {
                  if (!dragPath) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = "move";
                  setDropDir(dropDirFor(entry));
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  // Without this the pane body below would take the same drop
                  // and move the entry to the repo root instead.
                  event.stopPropagation();
                  handleDrop(dropDirFor(entry));
                }}
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
        })}
      </>
    );
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
            className="toggle-button icon-button"
            onClick={() => beginDraft("file", creationDir())}
            title="New file"
          >
            <NewFileIcon />
          </button>
          <button
            className="toggle-button icon-button"
            onClick={() => beginDraft("folder", creationDir())}
            title="New folder"
          >
            <NewFolderIcon />
          </button>
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
            onClick={refreshAll}
            title="Refresh"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>
      <div
        className="pane-body"
        data-drop={Boolean(dragPath) && dropDir === root}
        onContextMenu={(event) =>
          menu.openContextMenu(event, [...paneEntries(), "separator", "app"])
        }
        onDragOver={(event) => {
          if (!dragPath) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropDir(root);
        }}
        onDrop={(event) => {
          event.preventDefault();
          handleDrop(root);
        }}
      >
        {error && <div className="empty-note">{error}</div>}
        {!error && !children[root] && <div className="empty-note">Loading…</div>}
        {renderLevel(root, 0)}
      </div>
    </div>
  );
});
