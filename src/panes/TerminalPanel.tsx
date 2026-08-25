import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Resizer } from "../layout/Split";
import { CHORD } from "../lib/keybindings";
import { useMenu, type MenuEntry } from "../lib/menu";
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
  split: () => void;
  closePane: () => void;
}

/** Which edge of the centre column the panel is docked to. */
export type TerminalDock = "bottom" | "right";

/** One shell. `id` is the key the Rust side stores the pty under. */
interface TerminalSlot {
  id: string;
  /** Flex weight inside its tab, so a split can be dragged. */
  weight: number;
}

/** One tab, holding one shell or several side by side. */
interface TerminalTab {
  id: string;
  slots: TerminalSlot[];
  activeSlot: string;
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
 */
let sequence = 0;

const mintId = (prefix: string) => `${prefix}:${(sequence += 1)}`;

function makeSlot(): TerminalSlot {
  return { id: mintId("term"), weight: 1 };
}

function makeTab(): TerminalTab {
  const slot = makeSlot();
  return { id: mintId("tab"), slots: [slot], activeSlot: slot.id };
}

function makeGroup(): RepoTerminals {
  const tab = makeTab();
  return { tabs: [tab], activeTab: tab.id };
}

/** Smallest share of a tab's width a split pane can be dragged down to. */
const MIN_SHARE = 0.08;

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
 * group, and side-by-side splits within a tab.
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

  const splitTab = useCallback(() => {
    if (!repo) return;
    if (!visible) onRequestShow();
    const slot = makeSlot();
    focusSlot(slot.id);
    setGroups((current) => {
      const existing = current[repo];
      if (!existing) return current;
      const tabs = existing.tabs.map((tab) => {
        if (tab.id !== existing.activeTab) return tab;
        // Inserted after the pane being split, as a split of that pane rather
        // than an append to the row.
        const at = tab.slots.findIndex((candidate) => candidate.id === tab.activeSlot);
        const index = at < 0 ? tab.slots.length : at + 1;
        const slots = [...tab.slots.slice(0, index), slot, ...tab.slots.slice(index)];
        return { ...tab, slots, activeSlot: slot.id };
      });
      return { ...current, [repo]: { ...existing, tabs } };
    });
  }, [repo, visible, onRequestShow, focusSlot]);

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
    (tabId: string, doomed: (slot: TerminalSlot) => boolean) => {
      if (!repo) return;
      const existing = groups[repo];
      if (!existing) return;
      const tabs: TerminalTab[] = [];
      for (const tab of existing.tabs) {
        if (tab.id !== tabId) {
          tabs.push(tab);
          continue;
        }
        const slots = tab.slots.filter((slot) => !doomed(slot));
        // A tab is its panes; the last one closing takes the tab with it.
        if (slots.length === 0) continue;
        const activeSlot = slots.some((slot) => slot.id === tab.activeSlot)
          ? tab.activeSlot
          : slots[0].id;
        tabs.push({ ...tab, slots, activeSlot });
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
    (tabId: string, slotId: string) => closeSlots(tabId, (slot) => slot.id === slotId),
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
   * `index` is the slot to the right of the divider, matching the render below.
   */
  const resizeSlot = useCallback(
    (tabId: string, index: number, delta: number) => {
      if (!repo) return;
      const width = bodies.current.get(tabId)?.clientWidth ?? 0;
      if (width <= 0) return;
      setGroups((current) => {
        const existing = current[repo];
        if (!existing) return current;
        const tabs = existing.tabs.map((tab) => {
          if (tab.id !== tabId) return tab;
          const left = tab.slots[index - 1];
          const right = tab.slots[index];
          if (!left || !right) return tab;
          const total = tab.slots.reduce((sum, slot) => sum + slot.weight, 0);
          const pair = left.weight + right.weight;
          const min = MIN_SHARE * total;
          // Two minimums do not fit in the pair, so there is nothing to give.
          if (pair < min * 2) return tab;
          const wanted = left.weight + (delta / width) * total;
          const nextLeft = Math.min(Math.max(wanted, min), pair - min);
          const slots = tab.slots.map((slot, at) => {
            if (at === index - 1) return { ...slot, weight: nextLeft };
            if (at === index) return { ...slot, weight: pair - nextLeft };
            return slot;
          });
          return { ...tab, slots };
        });
        return { ...current, [repo]: { ...existing, tabs } };
      });
    },
    [repo],
  );

  // Publish the actions the Terminal menu drives, and take them back down on
  // unmount so a stale closure cannot outlive the panel.
  useEffect(() => {
    onRegisterActions?.({ newTab: addTab, split: splitTab, closePane: closeActiveSlot });
    return () => onRegisterActions?.(null);
  }, [onRegisterActions, addTab, splitTab, closeActiveSlot]);

  /** Right-click on the bar, a tab, or the empty strip beside them. */
  const barMenu = useCallback(
    (tabId: string | null): MenuEntry[] => [
      { label: "New Terminal Tab", accelerator: CHORD.newTerminal, run: addTab },
      {
        label: "Split Terminal",
        accelerator: CHORD.splitTerminal,
        disabled: !group,
        run: splitTab,
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
    [addTab, splitTab, closeTab, group, dock, onDock, onClose],
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
          {group?.tabs.map((tab, index) => (
            <button
              key={tab.id}
              className="terminal-tab"
              data-active={tab.id === group.activeTab}
              onClick={() => selectTab(tab.id)}
              onContextMenu={(event) => menu.openContextMenu(event, barMenu(tab.id))}
              title={tab.slots.length > 1 ? `${tab.slots.length} panes` : undefined}
            >
              <span>
                {index + 1}
                {tab.slots.length > 1 ? ` · ${tab.slots.length}` : ""}
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
          ))}
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
            onClick={splitTab}
            title="Split terminal side by side (Ctrl+Shift+5)"
            disabled={!group}
          >
            ⇔
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
                    {tab.slots.map((slot, index) => {
                      const slotActive = tabShown && visible && slot.id === tab.activeSlot;
                      return (
                        <Fragment key={slot.id}>
                          {index > 0 && (
                            <Resizer
                              orientation="vertical"
                              onDelta={(delta) => resizeSlot(tab.id, index, delta)}
                            />
                          )}
                          <div
                            className="terminal-slot"
                            style={{ flex: `${slot.weight} 1 0` }}
                            data-active={slotActive && tab.slots.length > 1}
                            onMouseDown={() => selectSlot(tab.id, slot.id)}
                          >
                            {tab.slots.length > 1 && (
                              <button
                                className="terminal-slot-close"
                                title="Close pane (Ctrl+Shift+W)"
                                onClick={() => closeSlot(tab.id, slot.id)}
                              >
                                ×
                              </button>
                            )}
                            <TerminalPane
                              id={slot.id}
                              cwd={groupRepo}
                              refitToken={refitToken + showToken}
                              themeKey={themeKey}
                              focusRequest={
                                focusTarget.slot === slot.id ? focusTarget.seq : 0
                              }
                              paneActions={[
                                "separator",
                                ...barMenu(tab.id),
                                tab.slots.length > 1 && {
                                  label: "Close Pane",
                                  accelerator: CHORD.closeTerminal,
                                  danger: true,
                                  run: () => closeSlot(tab.id, slot.id),
                                },
                              ]}
                            />
                          </div>
                        </Fragment>
                      );
                    })}
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
