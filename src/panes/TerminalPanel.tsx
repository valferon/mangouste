import { useCallback, useEffect, useRef, useState } from "react";
import { Resizer } from "../layout/Split";
import { CHORD } from "../lib/keybindings";
import { useMenu, type MenuEntry } from "../lib/menu";
import {
  layoutTree,
  leaf,
  paneIds,
  removePane,
  resizeSplit,
  splitPane,
  type PaneNode,
  type Rect,
  type SplitDirection,
} from "../lib/terminalLayout";
import { idScope } from "../lib/windowScope";
import { TerminalPane } from "./TerminalPane";

/**
 * What the Terminal menu can ask this panel to do.
 *
 * The tab and split bookkeeping stays here — lifting it into `App` would put
 * three more pieces of state next to the ones that drive the whole workbench —
 * so the panel publishes the handles instead.
 */
export interface TerminalActions {
  newTab: () => void;
  /**
   * Bring up the tab running `launch` in the front repo, opening one if the
   * repo has none: a command like `claude remote-control` is a long-lived
   * service, and a second click wants the one already running, not a twin.
   */
  runInTab: (launch: string, title: string) => void;
  /** Split the pane in front side by side. */
  split: () => void;
  /** Split the pane in front into two stacked ones. */
  splitDown: () => void;
  closePane: () => void;
}

/** Which edge of the centre column the panel is docked to. */
export type TerminalDock = "bottom" | "right";

/**
 * One tab, holding one shell or several split side by side and stacked.
 *
 * Each pane's id is the key the Rust side stores its pty under.
 */
interface TerminalTab {
  id: string;
  layout: PaneNode;
  activeSlot: string;
  /** The shell the tab opened with, the one `launch` is typed into. */
  origin: string;
  /** Typed into the tab's first shell once it is up. Absent for a plain shell. */
  launch?: string;
  /** Shown in place of the tab's number, for a tab opened to run something. */
  title?: string;
}

/** Every terminal one repo owns. */
interface RepoTerminals {
  tabs: TerminalTab[];
  activeTab: string;
}

/**
 * Monotonic, and module-level rather than a ref.
 *
 * The Rust side keys terminals by id and `pty_open` closes whatever it already
 * has under the id it is handed, so a counter that restarted with the component
 * would hand a fresh pane the id of a live shell and kill it.
 *
 * That is also why the id carries the window: this counter is per webview, so
 * without a scope a second window's first shell would open under `term:1` and
 * close the first window's.
 */
let sequence = 0;

const mintId = (prefix: string) => `${idScope()}${prefix}:${(sequence += 1)}`;

function makeTab(launch?: string, title?: string): TerminalTab {
  const slot = mintId("term");
  return { id: mintId("tab"), layout: leaf(slot), activeSlot: slot, origin: slot, launch, title };
}

function makeGroup(): RepoTerminals {
  const tab = makeTab();
  return { tabs: [tab], activeTab: tab.id };
}

interface TerminalPanelProps {
  /** Repo in front. Its group is the one the tab strip and stack show. */
  repo: string;
  visible: boolean;
  /** Panel size along the docked edge, in pixels, owned by the parent's drag handle. */
  size: number;
  /** Bottom of the column, or its right-hand side. */
  dock: TerminalDock;
  /** Bumped by the parent when the panel's box changes, to force a refit. */
  refitToken: number;
  themeKey: string;
  /** Hide the panel: the × button, and closing the last terminal of a repo. */
  onClose: () => void;
  /** Show the panel, for a chord pressed while it is hidden. */
  onRequestShow: () => void;
  /** Move the panel to the other edge. */
  onDock: (dock: TerminalDock) => void;
  /** Publishes new/split/close upward, for the menu bar. */
  onRegisterActions?: (actions: TerminalActions | null) => void;
}

/**
 * The bottom terminal panel: one group of terminals per repo, tabs within a
 * group, and splits within a tab, side by side or stacked.
 *
 * Nothing is unmounted while the app is running. `TerminalPane`'s cleanup closes
 * its pty, which kills the shell and everything running in it, so a hidden pane
 * — another repo's, another tab's, the whole panel collapsed — is a pane with
 * `display: none`, not an absent one. That is the whole reason this component
 * holds every repo's state at once instead of being keyed on the active repo.
 */
export function TerminalPanel({
  repo,
  visible,
  size,
  dock,
  refitToken,
  themeKey,
  onClose,
  onRequestShow,
  onDock,
  onRegisterActions,
}: TerminalPanelProps) {
  const menu = useMenu();
  const [groups, setGroups] = useState<Record<string, RepoTerminals>>({});
  /**
   * The pane a user action asked for the caret in, and how many asks ago.
   *
   * The slot is half the state, not decoration. A bare counter has to be handed
   * to the panes through "the active one gets it", and "which pane is active"
   * changes when nobody asked for anything — a repo switch, the panel being
   * shown — so every pane that gained or lost that status saw its prop move and
   * took the caret out of the chat. Naming the target means only the pane that
   * was actually asked for ever sees a change.
   */
  const [focusTarget, setFocusTarget] = useState<{ seq: number; slot: string | null }>({
    seq: 0,
    slot: null,
  });
  /** Ask for the caret in one pane. `null` is an ask that lost its target. */
  const focusSlot = useCallback((slot: string | null) => {
    setFocusTarget((current) => ({ seq: current.seq + 1, slot }));
  }, []);
  /**
   * Bumped whenever a pane goes from hidden to shown, since a `display: none`
   * box has no measurable size and its last fit() was therefore a no-op.
   */
  const [showToken, setShowToken] = useState(0);
  /** Tab bodies, measured to turn a pixel drag into a weight change. */
  const bodies = useRef(new Map<string, HTMLDivElement>());

  const group = repo ? groups[repo] : undefined;

  // First terminal for a repo, spawned lazily: a login shell per repo the user
  // merely clicks past is a process nobody asked for, so the group is created
  // when the repo is in front of an open panel.
  useEffect(() => {
    if (!visible || !repo) return;
    setGroups((current) => (current[repo] ? current : { ...current, [repo]: makeGroup() }));
  }, [visible, repo]);

  useEffect(() => setShowToken((token) => token + 1), [repo, group?.activeTab, visible, dock]);

  const addTab = useCallback(() => {
    if (!repo) return;
    if (!visible) onRequestShow();
    // Minted out here so the focus ask can name it. The updater may still
    // decline to add it, and an ask for a pane that never appears focuses
    // nothing, which is the same as not asking.
    const tab = makeTab();
    focusSlot(tab.activeSlot);
    setGroups((current) => {
      const existing = current[repo];
      // No group yet: this tab is the group. Bailing out instead would leave the
      // seed effect to make one out of a tab this click never named, and the
      // caret would stay in the chat — while adding a tab on top of that one
      // would be a shell the click did not ask for either.
      if (!existing) return { ...current, [repo]: { tabs: [tab], activeTab: tab.id } };
      return { ...current, [repo]: { tabs: [...existing.tabs, tab], activeTab: tab.id } };
    });
  }, [repo, visible, onRequestShow, focusSlot]);

  const runInTab = useCallback(
    (launch: string, title: string) => {
      if (!repo) return;
      if (!visible) onRequestShow();
      const running = groups[repo]?.tabs.find((tab) => tab.launch === launch);
      const tab = running ?? makeTab(launch, title);
      focusSlot(tab.activeSlot);
      setGroups((current) => {
        const existing = current[repo];
        if (!existing) return { ...current, [repo]: { tabs: [tab], activeTab: tab.id } };
        const tabs = existing.tabs.some((candidate) => candidate.id === tab.id)
          ? existing.tabs
          : [...existing.tabs, tab];
        return { ...current, [repo]: { tabs, activeTab: tab.id } };
      });
    },
    [repo, visible, groups, onRequestShow, focusSlot],
  );

  const splitTab = useCallback((dir: SplitDirection) => {
    if (!repo) return;
    if (!visible) onRequestShow();
    const slot = mintId("term");
    focusSlot(slot);
    setGroups((current) => {
      const existing = current[repo];
      if (!existing) return current;
      const tabs = existing.tabs.map((tab) => {
        if (tab.id !== existing.activeTab) return tab;
        // A split of the pane in front, not an append to the tab: the new
        // shell lands right of it or below it, wherever it sits in the tree.
        const layout = splitPane(tab.layout, tab.activeSlot, slot, dir);
        return { ...tab, layout, activeSlot: slot };
      });
      return { ...current, [repo]: { ...existing, tabs } };
    });
  }, [repo, visible, onRequestShow, focusSlot]);

  const splitRight = useCallback(() => splitTab("row"), [splitTab]);
  const splitDown = useCallback(() => splitTab("column"), [splitTab]);

  const selectTab = useCallback((tabId: string) => {
    if (!repo) return;
    const picked = groups[repo]?.tabs.find((tab) => tab.id === tabId);
    focusSlot(picked?.activeSlot ?? null);
    setGroups((current) => {
      const existing = current[repo];
      if (!existing || existing.activeTab === tabId) return current;
      return { ...current, [repo]: { ...existing, activeTab: tabId } };
    });
  }, [repo, groups, focusSlot]);

  const selectSlot = useCallback((tabId: string, slotId: string) => {
    if (!repo) return;
    setGroups((current) => {
      const existing = current[repo];
      if (!existing) return current;
      const tabs = existing.tabs.map((tab) =>
        tab.id === tabId && tab.activeSlot !== slotId ? { ...tab, activeSlot: slotId } : tab,
      );
      return { ...current, [repo]: { ...existing, tabs } };
    });
  }, [repo]);

  /**
   * Drop panes and the tabs that held them, and the panel with the last tab.
   *
   * Computed against the current state rather than inside a `setGroups` updater,
   * because the updater does not run until React processes the update — so an
   * "everything is gone" flag set in there is still false by the time this
   * function would read it.
   */
  const closeSlots = useCallback(
    (tabId: string, doomed: (slot: string) => boolean) => {
      if (!repo) return;
      const existing = groups[repo];
      if (!existing) return;
      const tabs: TerminalTab[] = [];
      for (const tab of existing.tabs) {
        if (tab.id !== tabId) {
          tabs.push(tab);
          continue;
        }
        let layout: PaneNode | null = tab.layout;
        for (const slot of paneIds(tab.layout)) {
          if (layout && doomed(slot)) layout = removePane(layout, slot);
        }
        // A tab is its panes; the last one closing takes the tab with it.
        if (!layout) continue;
        const remaining = paneIds(layout);
        const activeSlot = remaining.includes(tab.activeSlot) ? tab.activeSlot : remaining[0];
        tabs.push({ ...tab, layout, activeSlot });
      }
      if (tabs.length === 0) {
        // Dropping the group and hiding the panel together: the effect above
        // only re-creates a group when `visible` or `repo` changes, so a group
        // dropped under an open panel would leave an empty panel behind.
        setGroups((current) => {
          const next = { ...current };
          delete next[repo];
          return next;
        });
        onClose();
        return;
      }
      const activeTab = tabs.some((tab) => tab.id === existing.activeTab)
        ? existing.activeTab
        : tabs[0].id;
      // The caret was in the pane that just closed, so it goes to whichever
      // pane is now in front rather than back to the chat.
      focusSlot(tabs.find((tab) => tab.id === activeTab)?.activeSlot ?? null);
      setGroups((current) => ({ ...current, [repo]: { tabs, activeTab } }));
    },
    [repo, groups, onClose, focusSlot],
  );

  const closeSlot = useCallback(
    (tabId: string, slotId: string) => closeSlots(tabId, (slot) => slot === slotId),
    [closeSlots],
  );

  const closeTab = useCallback(
    (tabId: string) => closeSlots(tabId, () => true),
    [closeSlots],
  );

  const closeActiveSlot = useCallback(() => {
    if (!group) return;
    const tab = group.tabs.find((candidate) => candidate.id === group.activeTab);
    if (tab) closeSlot(tab.id, tab.activeSlot);
  }, [group, closeSlot]);

  /**
   * Turn a divider drag into a weight change for the pair it sits between.
   *
   * `extent` is the split's share of the tab body along `dir`, from the layout,
   * so the pixel delta can be read as a fraction of the split itself.
   */
  const resizeSlot = useCallback(
    (
      tabId: string,
      split: string,
      index: number,
      dir: SplitDirection,
      extent: number,
      delta: number,
    ) => {
      if (!repo) return;
      const body = bodies.current.get(tabId);
      const size = (dir === "row" ? body?.clientWidth : body?.clientHeight) ?? 0;
      if (size * extent <= 0) return;
      setGroups((current) => {
        const existing = current[repo];
        if (!existing) return current;
        const tabs = existing.tabs.map((tab) => {
          if (tab.id !== tabId) return tab;
          const layout = resizeSplit(tab.layout, split, index, delta / (size * extent));
          return layout === tab.layout ? tab : { ...tab, layout };
        });
        return { ...current, [repo]: { ...existing, tabs } };
      });
    },
    [repo],
  );

  // Publish the actions the Terminal menu drives, and take them back down on
  // unmount so a stale closure cannot outlive the panel.
  useEffect(() => {
    onRegisterActions?.({
      newTab: addTab,
      runInTab,
      split: splitRight,
      splitDown,
      closePane: closeActiveSlot,
    });
    return () => onRegisterActions?.(null);
  }, [onRegisterActions, addTab, runInTab, splitRight, splitDown, closeActiveSlot]);

  /** Right-click on the bar, a tab, or the empty strip beside them. */
  const barMenu = useCallback(
    (tabId: string | null): MenuEntry[] => [
      { label: "New Terminal Tab", accelerator: CHORD.newTerminal, run: addTab },
      {
        label: "Split Terminal Right",
        accelerator: CHORD.splitTerminal,
        disabled: !group,
        run: splitRight,
      },
      {
        label: "Split Terminal Down",
        accelerator: CHORD.splitTerminalDown,
        disabled: !group,
        run: splitDown,
      },
      "separator",
      tabId && {
        label: "Close Terminal Tab",
        danger: true,
        run: () => closeTab(tabId),
      },
      "separator",
      {
        label: dock === "right" ? "Move Panel to the Bottom" : "Move Panel to the Right",
        accelerator: CHORD.dockTerminal,
        run: () => onDock(dock === "right" ? "bottom" : "right"),
      },
      {
        label: "Hide Terminal Panel",
        accelerator: CHORD.toggleTerminal,
        run: onClose,
      },
    ],
    [addTab, splitRight, splitDown, closeTab, group, dock, onDock, onClose],
  );

  return (
    <div
      className="terminal-panel"
      data-dock={dock}
      // Shrinkable, unlike the chat beside it, whose `flex: 1` basis of 0 leaves
      // it nothing to give: when the column is smaller than the stored size, the
      // panel is the item that yields rather than overflowing its edge.
      style={{
        ...(dock === "right" ? { width: size } : { height: size }),
        flex: `0 1 ${size}px`,
        display: visible ? "flex" : "none",
      }}
    >
      <div
        className="terminal-bar"
        onContextMenu={(event) => menu.openContextMenu(event, barMenu(null))}
      >
        <span className="terminal-repo-label" title={repo}>
          {repo.split("/").pop() ?? ""}
        </span>
        <div className="terminal-tabs">
          {group?.tabs.map((tab, index) => {
            const panes = paneIds(tab.layout).length;
            return (
            <button
              key={tab.id}
              className="terminal-tab"
              data-active={tab.id === group.activeTab}
              onClick={() => selectTab(tab.id)}
              onContextMenu={(event) => menu.openContextMenu(event, barMenu(tab.id))}
              title={tab.launch ?? (panes > 1 ? `${panes} panes` : undefined)}
            >
              <span>
                {tab.title ?? index + 1}
                {panes > 1 ? ` · ${panes}` : ""}
              </span>
              <span
                className="close"
                role="button"
                aria-label="Close terminal tab"
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                ×
              </span>
            </button>
            );
          })}
        </div>
        <div className="actions">
          <button
            className="toggle-button"
            onClick={addTab}
            title="New terminal tab (Ctrl+Shift+T)"
          >
            +
          </button>
          <button
            className="toggle-button"
            onClick={splitRight}
            title={`Split terminal right (${CHORD.splitTerminal})`}
            disabled={!group}
          >
            ⇔
          </button>
          <button
            className="toggle-button"
            onClick={splitDown}
            title={`Split terminal down (${CHORD.splitTerminalDown})`}
            disabled={!group}
          >
            ⇕
          </button>
          <button className="toggle-button" onClick={onClose} title="Hide terminal (Ctrl+`)">
            ×
          </button>
        </div>
      </div>

      <div className="terminal-stack">
        {Object.entries(groups).map(([groupRepo, groupState]) => {
          const repoShown = groupRepo === repo;
          return (
            <div
              key={groupRepo}
              className="terminal-repo"
              style={{ display: repoShown ? "flex" : "none" }}
            >
              {groupState.tabs.map((tab) => {
                const tabShown = repoShown && tab.id === groupState.activeTab;
                const { panes, dividers } = layoutTree(tab.layout);
                const split = panes.length > 1;
                return (
                  <div
                    key={tab.id}
                    className="terminal-tab-body"
                    style={{ display: tab.id === groupState.activeTab ? "flex" : "none" }}
                    ref={(element) => {
                      if (element) bodies.current.set(tab.id, element);
                      else bodies.current.delete(tab.id);
                    }}
                  >
                    {/* Flat and placed by rectangle, never nested: a pane that
                        moved under a new wrapper on a split would be remounted,
                        and remounting closes its pty. */}
                    {panes.map((pane) => {
                      const slotActive = tabShown && visible && pane.id === tab.activeSlot;
                      return (
                        <div
                          key={pane.id}
                          className="terminal-slot"
                          style={placeAt(pane)}
                          data-active={slotActive && split}
                          data-edge-left={pane.x > 0}
                          data-edge-top={pane.y > 0}
                          onMouseDown={() => selectSlot(tab.id, pane.id)}
                        >
                          {split && (
                            <button
                              className="terminal-slot-close"
                              title={`Close pane (${CHORD.closeTerminal})`}
                              onClick={() => closeSlot(tab.id, pane.id)}
                            >
                              ×
                            </button>
                          )}
                          <TerminalPane
                            id={pane.id}
                            cwd={groupRepo}
                            // The tab's command runs in the shell it opened
                            // with; a split beside it is a plain shell.
                            launch={pane.id === tab.origin ? tab.launch : undefined}
                            refitToken={refitToken + showToken}
                            themeKey={themeKey}
                            focusRequest={focusTarget.slot === pane.id ? focusTarget.seq : 0}
                            paneActions={[
                              "separator",
                              ...barMenu(tab.id),
                              split && {
                                label: "Close Pane",
                                accelerator: CHORD.closeTerminal,
                                danger: true,
                                run: () => closeSlot(tab.id, pane.id),
                              },
                            ]}
                          />
                        </div>
                      );
                    })}
                    {dividers.map((divider) => (
                      <div
                        key={`${divider.split}:${divider.index}`}
                        className="terminal-divider"
                        data-dir={divider.dir}
                        style={placeAt(divider)}
                      >
                        <Resizer
                          orientation={divider.dir === "row" ? "vertical" : "horizontal"}
                          onDelta={(delta) =>
                            resizeSlot(
                              tab.id,
                              divider.split,
                              divider.index,
                              divider.dir,
                              divider.extent,
                              delta,
                            )
                          }
                        />
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A layout rectangle as absolute percentages of the tab body. */
function placeAt(rect: Rect): React.CSSProperties {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.w * 100}%`,
    height: `${rect.h * 100}%`,
  };
}

