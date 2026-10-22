import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  closePane,
  followRepoSwitch,
  growShares,
  isPaneList,
  paneRoot,
  rerootPane,
  resizePanes,
  splitPane,
  type ExplorerPane,
} from "../lib/explorerPanes";
import { homeDir, watchTree } from "../lib/ipc";
import { KEYS, readJson, writeJson } from "../lib/persist";
import { Resizer } from "../layout/Split";
import { FileTree } from "./FileTree";

interface ExplorerStackProps {
  repo: string;
  onOpenFile: (path: string) => void;
  selectedPath: string | null;
  onPathRenamed: (from: string, to: string) => void;
  onPathDeleted: (path: string) => void;
  hasUnsavedEdits: (path: string) => boolean;
  refreshToken: number;
}

/** Ids outlive the window, so a counter restarting at 1 could reuse a stored one. */
const mintId = () => crypto.randomUUID();

const SINGLE: ExplorerPane[] = [{ id: "explorer", root: null, weight: 1 }];

/**
 * The explorer, as one or more trees stacked top to bottom.
 *
 * Each pane is a full `FileTree` with its own root, cache and expansions; this
 * only owns the list, the dividers between them, and the one thing they cannot
 * do alone — the window's watch set, which is a single set per window.
 */
export function ExplorerStack({ repo, ...tree }: ExplorerStackProps) {
  const [panes, setPanes] = useState<ExplorerPane[]>(() =>
    readJson(KEYS.state.explorerPanes, SINGLE, isPaneList),
  );
  const [home, setHome] = useState<string | null>(null);
  /** Each pane's watched directories, newline-joined, keyed by pane id. */
  const [watched, setWatched] = useState<Record<string, string>>({});
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void homeDir().then(setHome).catch(() => {});
  }, []);

  useEffect(() => writeJson(KEYS.state.explorerPanes, panes), [panes]);

  // Only an actual switch moves the top pane: the first render is a restore,
  // and a tree pointed elsewhere before the restart should come back there.
  const lastRepo = useRef(repo);
  useEffect(() => {
    if (lastRepo.current === repo) return;
    lastRepo.current = repo;
    setPanes(followRepoSwitch);
  }, [repo]);

  // A closed pane's watches go with it.
  useEffect(() => {
    setWatched((current) => {
      const live = Object.entries(current).filter(([id]) => panes.some((pane) => pane.id === id));
      return live.length === Object.keys(current).length ? current : Object.fromEntries(live);
    });
  }, [panes]);

  const watchKey = [
    ...new Set(Object.values(watched).flatMap((dirs) => (dirs === "" ? [] : dirs.split("\n")))),
  ]
    .sort()
    .join("\n");
  useEffect(() => {
    void watchTree(watchKey === "" ? [] : watchKey.split("\n")).catch(() => {});
  }, [watchKey]);
  useEffect(() => () => void watchTree([]).catch(() => {}), []);

  /*
   * Per-pane callbacks, memoised by id so a `FileTree` does not see new props
   * (and re-run its watch effect) every time the stack re-renders.
   */
  const handlers = useRef(
    new Map<
      string,
      {
        reroot: (path: string) => void;
        split: (path?: string) => void;
        close: () => void;
        watch: (dirs: string) => void;
      }
    >(),
  );
  const repoRef = useRef(repo);
  repoRef.current = repo;
  const handlersFor = (id: string) => {
    let found = handlers.current.get(id);
    if (!found) {
      found = {
        reroot: (path) => setPanes((current) => rerootPane(current, id, path, repoRef.current)),
        split: (path) => setPanes((current) => splitPane(current, id, mintId(), path)),
        close: () => {
          handlers.current.delete(id);
          setPanes((current) => closePane(current, id));
        },
        watch: (dirs) =>
          setWatched((current) => (current[id] === dirs ? current : { ...current, [id]: dirs })),
      };
      handlers.current.set(id, found);
    }
    return found;
  };

  const resize = useCallback((index: number, delta: number) => {
    const height = body.current?.clientHeight ?? 0;
    setPanes((current) => resizePanes(current, index, delta, height));
  }, []);

  const shares = growShares(panes);

  return (
    <div className="explorer-stack" ref={body}>
      {panes.map((pane, index) => {
        const own = handlersFor(pane.id);
        return (
          <Fragment key={pane.id}>
            {index > 0 && (
              <Resizer orientation="horizontal" onDelta={(delta) => resize(index, delta)} />
            )}
            <div className="explorer-pane" style={{ flex: `${shares[index]} 1 0` }}>
              <FileTree
                {...tree}
                root={paneRoot(pane, repo)}
                repoRoot={repo}
                home={home}
                onReroot={own.reroot}
                onSplit={own.split}
                onClose={panes.length > 1 ? own.close : undefined}
                onWatch={own.watch}
              />
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
