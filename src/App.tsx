import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Resizer, usePersistentSize } from "./layout/Split";
import { ChatPane } from "./panes/ChatPane";
import { Dashboard } from "./panes/Dashboard";
import { FileTree } from "./panes/FileTree";
import { GitPane } from "./panes/GitPane";
import { QuickOpen } from "./panes/QuickOpen";
import { Settings } from "./panes/Settings";
import { StatusPanel, type ChatStats } from "./panes/StatusPanel";
import { SessionsPane } from "./panes/SessionsPane";
import {
  TerminalPanel,
  type TerminalActions,
  type TerminalDock,
} from "./panes/TerminalPanel";
import { DiffView, FileView } from "./panes/Viewer";
import { DebugLog } from "./panes/DebugLog";
import { AboutDialog, ISSUES_URL, REPO_URL, ShortcutsDialog } from "./panes/HelpPanels";
import { MenuBar } from "./panes/MenuBar";
import {
  appEntries,
  buildBarMenus,
  ID,
  tabMenu,
  viewEntries,
  type TabMenuContext,
} from "./panes/menus";
import { PaneBoundary } from "./panes/PaneBoundary";
import {
  claudeKill,
  discoverRepos,
  gitRoot,
  homeDir,
  openExternal,
  renameSession,
  revealPath,
} from "./lib/ipc";
import { clearDebug } from "./lib/debugLog";
import { copyText } from "./lib/editing";
import { FilesIcon, MongooseLogo, PencilIcon, SourceControlIcon } from "./lib/icons";
import { runChord, type Command } from "./lib/commands";
import { CHORD } from "./lib/keybindings";
import { MenuProvider, useMenu } from "./lib/menu";
import {
  KEYS,
  readBoolean,
  readBoolMap,
  readEnum,
  readJson,
  readString,
  writeBoolean,
  writeJson,
  writeString,
} from "./lib/persist";
import { installPrimarySelectionBridge } from "./lib/primary";
import { SessionFlagsProvider } from "./lib/sessionFlagsContext";
import { applyTheme, loadTheme, type Theme } from "./lib/theme";
import {
  cleanStoredTabs,
  restoreTab,
  storedTabId,
  toStoredTab,
  type ChatTab,
  type Tab,
} from "./lib/tabs";
import type { ProjectGroup, RepoInfo, SessionMeta } from "./lib/types";
import {
  applyZoom,
  closeWindow,
  DEFAULT_ZOOM,
  loadZoom,
  stepZoom,
  toggleFullScreen,
} from "./lib/viewport";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

/* Persisted keys all come from the catalogue in `lib/persist.ts`, so a reset or
   a migration can enumerate them without grepping for string literals. */
const WORKSPACE_KEY = KEYS.state.workspaceRoot;
const PERMISSION_MODE_KEY = KEYS.prefs.permissionMode;
const MODEL_KEY = KEYS.prefs.model;
const ACTIVE_REPO_KEY = KEYS.state.activeRepo;
const SIDEBAR_VIEW_KEY = KEYS.state.sidebarView;
const TERMINAL_DOCK_KEY = KEYS.state.terminalDock;

/** The left sidebar shows one of these at a time. */
type SidebarView = "explorer" | "git";

/** The activity rail, in order. `hint` is the chord shown in the tooltip. */
const ACTIVITY_ITEMS: {
  view: SidebarView;
  label: string;
  hint: string;
  Glyph: (props: { className?: string }) => React.ReactElement;
}[] = [
  { view: "explorer", label: "Explorer", hint: CHORD.explorer, Glyph: FilesIcon },
  { view: "git", label: "Source Control", hint: CHORD.sourceControl, Glyph: SourceControlIcon },
];

/**
 * Shared no-op for callbacks handed to inactive panes.
 *
 * A fresh `() => {}` per render defeats every memo and effect dependency
 * downstream, which is what made all four Tauri listeners rebind per render.
 */
const noop = () => {};

/** Floor for the terminal panel, matching the size hook's own minimum. */
const TERMINAL_MIN_HEIGHT = 80;

/** Space the editor keeps above the terminal, however far the divider is dragged. */
const TERMINAL_EDITOR_FLOOR = 140;

/** The same pair for a right-docked panel, where the axis is width. */
const TERMINAL_MIN_WIDTH = 200;
const TERMINAL_CHAT_FLOOR = 320;

/** There is one dashboard, so its tab has a fixed id rather than a minted one. */
const DASHBOARD_TAB = "dashboard";

/**
 * The tab strip as the last run left it, rebuilt synchronously.
 *
 * Called from the `tabs` initializer rather than an effect because the repo
 * seed effect below runs on first commit: an effect-based restore loses that
 * race and the seed mints a duplicate fresh tab before the restored ones land.
 * Restored rows are deduped by id and by session on the way in — openSessionTab
 * dedupes by sessionId so two processes can never append to one transcript,
 * and a store written by a crash mid-update could hold the same session twice.
 * The `new-<n>` counter needs no seeding against these ids: `toStoredTab`
 * drops unstarted sessions, so a restored id always carries a uuid, never a
 * counter value the next fresh tab could collide with.
 */
function loadRestoredTabs(): Tab[] {
  if (!readBoolean(KEYS.prefs.restoreTabs, true)) return [];
  const stored = cleanStoredTabs(
    readJson<unknown[]>(KEYS.state.openTabs, [], Array.isArray),
  );
  const seenIds = new Set<string>();
  const seenSessions = new Set<string>();
  const restored: Tab[] = [];
  for (const entry of stored) {
    const id = storedTabId(entry);
    if (seenIds.has(id)) continue;
    if (entry.kind === "chat") {
      if (seenSessions.has(entry.sessionId)) continue;
      seenSessions.add(entry.sessionId);
    }
    seenIds.add(id);
    restored.push(restoreTab(entry));
  }
  return restored;
}

/**
 * Whether a keystroke landed in a shell, which has a prior claim on some chords.
 *
 * Ctrl+W is readline's delete-word and Ctrl+N is history-forward, so binding
 * them window-wide would break both inside a terminal. The workbench keeps them
 * everywhere else.
 */
function inTerminal(event: KeyboardEvent): boolean {
  return event.target instanceof Element && event.target.closest(".terminal-host") !== null;
}

/**
 * Providers only.
 *
 * The workbench is a sibling of nothing and a child of both, because it is the
 * component that calls `useMenu()` — a provider cannot consume its own context,
 * so the split is what lets the tab strip and the sidebars open menus.
 */
export default function App() {
  return (
    <SessionFlagsProvider>
      <MenuProvider>
        <Workbench />
      </MenuProvider>
    </SessionFlagsProvider>
  );
}

function Workbench() {
  const menu = useMenu();
  const [workspaceRoot, setWorkspaceRoot] = useState<string>(
    () => readString(WORKSPACE_KEY),
  );
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  /** Session groups lifted from the sidebar, so quick-open can rank by recency. */
  const [sessionGroups, setSessionGroups] = useState<ProjectGroup[]>([]);
  const [quickOpen, setQuickOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [permissionMode, setPermissionMode] = useState(
    () => readString(PERMISSION_MODE_KEY, "acceptEdits"),
  );
  /** `--model` alias new panes spawn with; "default" leaves the flag off. */
  const [modelAlias, setModelAlias] = useState(() => readString(MODEL_KEY, "default"));
  /**
   * Whether the last run's tabs come back on launch.
   *
   * Gates only the read in the tab initialisers below — the strip is recorded
   * either way, so switching this back on restores the run before, not an
   * empty strip frozen from whenever it was switched off.
   */
  const [restoreTabs, setRestoreTabs] = useState(() =>
    readBoolean(KEYS.prefs.restoreTabs, true),
  );
  useEffect(() => {
    writeBoolean(KEYS.prefs.restoreTabs, restoreTabs);
  }, [restoreTabs]);
  /** Live facts lifted out of the chat pane for the status panel. */
  const [chatStats, setChatStats] = useState<ChatStats>({
    sessionId: null,
    model: null,
    contextTokens: 0,
    costUsd: null,
    title: null,
  });
  const [activeRepo, setActiveRepo] = useState<string>(
    () => readString(ACTIVE_REPO_KEY),
  );

  const [tabs, setTabs] = useState<Tab[]>(loadRestoredTabs);
  const [activeTab, setActiveTab] = useState(() => {
    // Checked against the list actually restored above: `currentTab` has no
    // fallback branch, so a dangling id — the diff tab dropped at save time, a
    // corrupt row dropped at load, the "New session" tab toStoredTab refuses —
    // would leave the centre pane blank. The fallback must never settle on a
    // chat from a non-active repo: such a tab would be visible for the first
    // commit, and ChatPane's warm latch fires on that commit — before the
    // repo-seed effect below can re-focus — spawning a background `claude` and
    // reading its transcript at boot for a tab the strip does not even show.
    const remembered = readString(KEYS.state.activeTab);
    if (tabs.some((tab) => tab.id === remembered)) return remembered;
    const fallback = tabs.find(
      (tab) => tab.kind !== "chat" || tab.cwd === activeRepo,
    );
    return fallback?.id ?? "";
  });
  /**
   * Restored chat tabs that have not been looked at since boot.
   *
   * The Firefox lazy-tab trade: a cold pane mounts but spawns no `claude`
   * process and reads no transcript until its first activation, so eight
   * restored tabs cost the strip eight labels at boot instead of eight CLIs
   * and eight transcript reads. Never persisted — coldness is a fact about
   * this run (this tab has not been shown since launch), not a preference;
   * written to disk it would survive into a run where the tab had been front
   * and centre for hours.
   */
  const [coldTabs, setColdTabs] = useState<Set<string>>(
    () => new Set(tabs.filter((tab) => tab.kind === "chat").map((tab) => tab.id)),
  );
  // Warming is one-way: the first activation pays the spawn and the transcript
  // read, and nothing puts a pane back to sleep — ChatPane's own latch is
  // monotonic for the same reason.
  useEffect(() => {
    setColdTabs((current) => {
      if (!current.has(activeTab)) return current;
      const next = new Set(current);
      next.delete(activeTab);
      return next;
    });
  }, [activeTab]);
  // Written through on every commit rather than from inside the setTabs
  // updaters: React may run an updater twice (the claudeKill in forceCloseTab
  // was moved outside for exactly that reason), and an effect only sees
  // committed state. Riding on [tabs] also catches the session-id write-back
  // in handleSessionId and the resumeFile back-fill below without either
  // knowing about persistence, so a restart just after the CLI announces its
  // uuid still resumes instead of respawning fresh and orphaning the
  // transcript. The pair is written together so a restored activeTab always
  // points into the list it was stored with. `flatMap` because
  // `filter(Boolean)` does not narrow `(StoredTab | null)[]` in TypeScript.
  useEffect(() => {
    writeJson(
      KEYS.state.openTabs,
      tabs.flatMap((tab) => {
        const stored = toStoredTab(tab);
        return stored ? [stored] : [];
      }),
    );
    writeString(KEYS.state.activeTab, activeTab);
  }, [tabs, activeTab]);
  /**
   * Paths whose editor holds unsaved changes, for the tab mark and the close
   * guard. Keyed by path because that is what the editor knows; a file tab's id
   * is `file:<path>`, so the two map onto each other without bookkeeping.
   */
  const [dirtyFiles, setDirtyFiles] = useState<Record<string, boolean>>({});
  /** Newest process notice, shown in the status bar instead of the transcript. */
  const [systemMessage, setSystemMessage] = useState<string | null>(null);
  /** Technical transport state of the front chat, for the status bar. */
  const [phase, setPhase] = useState("idle");
  /** The session debug drawer, toggled from the status bar's phase chip. */
  const [debugOpen, setDebugOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  /** Session id of the chat tab currently in front, for the status panel. */
  const [liveSessionId, setLiveSessionId] = useState<string | null>(null);
  /** Makes each fresh tab id unique, so a new session never reuses a chat id. */
  const newSessionCounter = useRef(0);

  /**
   * Terminal visibility per repo root, persisted.
   *
   * TerminalPanel already keys its shells by repo precisely so a hidden repo's
   * shells stay alive; one shared boolean was the missing half of that split —
   * hiding the panel to read a chat in one repo blanked the terminal in every
   * other. A repo with no entry opens with a terminal showing, as the old
   * single boolean always did.
   */
  const [terminalOpen, setTerminalOpen] = useState<Record<string, boolean>>(
    () => readBoolMap(KEYS.state.terminalOpen),
  );
  const terminalVisible = terminalOpen[activeRepo] ?? true;
  useEffect(() => {
    // The "" entry is the no-repo window's flag (see showTerminal below): it
    // must work while the run lasts and mean nothing after it, so it is
    // stripped here rather than persisted.
    const persistable = { ...terminalOpen };
    delete persistable[""];
    writeJson(KEYS.state.terminalOpen, persistable);
  }, [terminalOpen]);
  /**
   * Explicit collapse, mirroring `terminalVisible`.
   *
   * The old Ctrl+B fed a delta into a setter clamped to [160,700], so the first
   * press pinned 160 and every later press recomputed 160 — and a 0 width must
   * never be persisted, since the size loader rejects it and resets to 300.
   */
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  /**
   * Which left view is showing.
   *
   * Stacked, the tree and the SCM pane each got a dozen rows on a laptop and
   * neither was readable, so they are tabs and only one is visible at a time.
   */
  const [sidebarView, setSidebarView] = useState<SidebarView>(() =>
    readEnum<SidebarView>(SIDEBAR_VIEW_KEY, ["explorer", "git"], "explorer"),
  );
  useEffect(() => {
    writeString(SIDEBAR_VIEW_KEY, sidebarView);
  }, [sidebarView]);
  /**
   * Rail click: switch views, or collapse when the view is already showing.
   *
   * Same as VSCode — the rail button for the open view is the collapse toggle,
   * and any other button both switches and reveals.
   */
  const toggleSidebarView = useCallback(
    (view: SidebarView) => {
      setLeftCollapsed((collapsed) => (sidebarView === view ? !collapsed : false));
      setSidebarView(view);
    },
    [sidebarView],
  );
  const [refitToken, setRefitToken] = useState(0);
  /**
   * Which edge the terminal panel sits on.
   *
   * Only a `flex-direction` and which axis the stored size applies to: the panel
   * keeps its place in the tree either way, because moving it would unmount it
   * and its cleanup kills every shell behind it.
   */
  const [terminalDock, setTerminalDock] = useState<TerminalDock>(() =>
    readEnum<TerminalDock>(TERMINAL_DOCK_KEY, ["bottom", "right"], "bottom"),
  );
  useEffect(() => {
    writeString(TERMINAL_DOCK_KEY, terminalDock);
    // The panel's box changes shape, so every grid in it has to be re-fitted.
    setRefitToken((token) => token + 1);
  }, [terminalDock]);

  /** The two Help sheets. Neither holds state worth keeping while closed. */
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  /** Webview zoom, remembered between runs and applied on boot. */
  const [zoom, setZoom] = useState(() => loadZoom());
  useEffect(() => {
    void applyZoom(zoom);
    // A zoom change resizes every cell in the terminal grid.
    setRefitToken((token) => token + 1);
  }, [zoom]);

  /**
   * The terminal panel's own actions, published upward.
   *
   * New/split/close live in `TerminalPanel` with the state they mutate, but the
   * Terminal menu has to reach them — so the panel hands them over rather than
   * having its tab bookkeeping lifted up here.
   */
  const terminalActions = useRef<TerminalActions | null>(null);
  const registerTerminalActions = useCallback((actions: TerminalActions | null) => {
    terminalActions.current = actions;
  }, []);

  /**
   * Reveal the panel and refit it, for a terminal chord pressed while hidden.
   *
   * Every write here and below touches the ACTIVE repo's entry only. With no
   * repo discovered the entry lands under "", deliberately: an empty workspace
   * still shows the panel, and it must stay hideable there — the old single
   * boolean always was. That flag lives only in state; the persist effect
   * above strips it, since a flag under "" is garbage that would outlive the
   * run.
   */
  const showTerminal = useCallback(() => {
    setTerminalOpen((current) =>
      current[activeRepo] === true ? current : { ...current, [activeRepo]: true },
    );
    setRefitToken((token) => token + 1);
  }, [activeRepo]);

  /** Ctrl+`, the titlebar button and the menus all go through this. */
  const toggleTerminal = useCallback(() => {
    setTerminalOpen((current) => ({
      ...current,
      // Absent means "never touched", which the derived read above renders as
      // open — so the first toggle of a fresh repo must hide, not show.
      [activeRepo]: !(current[activeRepo] ?? true),
    }));
    setRefitToken((token) => token + 1);
  }, [activeRepo]);

  /**
   * The panel's own close button. Hidden is not unmounted, so this only flips
   * the active repo's flag; hiding needs no refit.
   */
  const hideTerminal = useCallback(() => {
    setTerminalOpen((current) =>
      current[activeRepo] === false ? current : { ...current, [activeRepo]: false },
    );
  }, [activeRepo]);

  /**
   * Re-fit on a hidden→shown flip of the derived visibility, however caused.
   *
   * Switching repos can take the panel from hidden to shown without any of the
   * show/toggle paths running, and a `display: none` box has no measurable
   * size, so without this the grids come back fitted to a zero box.
   * TerminalPanel's own showToken covers a pane going visible inside an
   * already-open panel — not the panel itself. The previous value lives in a
   * ref so a repo switch that leaves visibility alone bumps nothing.
   */
  const wasTerminalVisible = useRef(terminalVisible);
  useEffect(() => {
    const was = wasTerminalVisible.current;
    wasTerminalVisible.current = terminalVisible;
    if (!was && terminalVisible) setRefitToken((token) => token + 1);
  }, [terminalVisible]);

  const [leftWidth, resizeLeft] = usePersistentSize("mangouste.leftWidth", 300, 160, 700);
  const [rightWidth, resizeRight] = usePersistentSize("mangouste.rightWidth", 300, 180, 700);
  // Third element, not the hook's own `resize`: the panel is clamped against the
  // live column height below, which the hook's fixed [80,900] range cannot see.
  const [terminalHeight, , setTerminalHeight] = usePersistentSize(
    "mangouste.terminalHeight",
    260,
    80,
    900,
  );
  // A separate key, so each dock remembers the size it was last dragged to
  // rather than inheriting a height that means nothing as a width.
  const [terminalWidth, , setTerminalWidth] = usePersistentSize(
    "mangouste.terminalWidth",
    420,
    200,
    1200,
  );
  /** The box the terminal panel shares with the editor, for that clamp. */
  const centerBody = useRef<HTMLDivElement>(null);

  /** The floor and the setter for whichever axis the dock is measured on. */
  const terminalAxis = useCallback(
    () =>
      terminalDock === "right"
        ? { min: TERMINAL_MIN_WIDTH, setSize: setTerminalWidth }
        : { min: TERMINAL_MIN_HEIGHT, setSize: setTerminalHeight },
    [terminalDock, setTerminalWidth, setTerminalHeight],
  );

  /**
   * Largest panel size that still leaves the editor something.
   *
   * A stored height taller than the window used to push the panel straight past
   * the bottom of the workbench, which clips at the status bar — so the terminal
   * looked like it ran underneath it, with its last rows unreachable.
   */
  const terminalLimit = useCallback(() => {
    const body = centerBody.current;
    return terminalDock === "right"
      ? Math.max(TERMINAL_MIN_WIDTH, (body?.clientWidth ?? 0) - TERMINAL_CHAT_FLOOR)
      : Math.max(TERMINAL_MIN_HEIGHT, (body?.clientHeight ?? 0) - TERMINAL_EDITOR_FLOOR);
  }, [terminalDock]);

  // Both docks grow the panel as the divider is dragged *towards* the editor,
  // so the delta is subtracted either way — left for a width, up for a height.
  const dragTerminal = useCallback(
    (delta: number) => {
      const limit = terminalLimit();
      const { min, setSize } = terminalAxis();
      setSize((current) => Math.min(Math.max(current - delta, min), limit));
      setRefitToken((token) => token + 1);
    },
    [terminalLimit, terminalAxis],
  );

  // Re-clamp when the window resizes, since the limit moves with it.
  useEffect(() => {
    const body = centerBody.current;
    if (!body) return;
    const { setSize } = terminalAxis();
    const clamp = () => {
      const limit = terminalLimit();
      setSize((current) => (current > limit ? limit : current));
    };
    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(body);
    return () => observer.disconnect();
  }, [terminalLimit, terminalAxis]);

  /* ---------- X11 selection behaviour ---------- */

  useEffect(() => installPrimarySelectionBridge(), []);

  // Stamp the stored theme before first paint so there is no dark/light flash.
  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => {
    writeString(PERMISSION_MODE_KEY, permissionMode);
  }, [permissionMode]);

  useEffect(() => {
    writeString(MODEL_KEY, modelAlias);
  }, [modelAlias]);

  /* ---------- workspace discovery ---------- */

  useEffect(() => {
    if (workspaceRoot) return;
    void homeDir().then((home) => {
      if (home) setWorkspaceRoot(`${home}/workspace`);
    });
  }, [workspaceRoot]);

  useEffect(() => {
    if (!workspaceRoot) return;
    writeString(WORKSPACE_KEY, workspaceRoot);
    void discoverRepos(workspaceRoot)
      .then((found) => setRepos(found.filter((repo) => repo.isGit)))
      .catch(() => setRepos([]));
  }, [workspaceRoot]);

  // Fall back to the first discovered repo when nothing is remembered.
  useEffect(() => {
    if (activeRepo || repos.length === 0) return;
    setActiveRepo(repos[0].path);
  }, [repos, activeRepo]);

  useEffect(() => {
    if (activeRepo) writeString(ACTIVE_REPO_KEY, activeRepo);
  }, [activeRepo]);

  const handleGroups = useCallback((groups: ProjectGroup[]) => setSessionGroups(groups), []);

  /**
   * Record the uuid a tab's process reported.
   *
   * A tab opened as "New session" has no uuid until the CLI announces one; once
   * it does, the tab can be matched by the sidebar and labelled with its title.
   */
  const handleSessionId = useCallback((tabId: string, sessionId: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.kind === "chat" && tab.id === tabId && tab.sessionId !== sessionId
          ? { ...tab, sessionId }
          : tab,
      ),
    );
  }, []);

  const handleChatStats = useCallback(
    (next: Omit<ChatStats, "title">) =>
      setChatStats((current) =>
        // The pane reports on every assistant frame; bail out when nothing
        // moved, or each streaming frame re-renders the whole app.
        current.sessionId === next.sessionId &&
        current.model === next.model &&
        current.contextTokens === next.contextTokens &&
        current.costUsd === next.costUsd
          ? current
          : { ...current, ...next },
      ),
    [],
  );

  /** Mirror of `activeTab` for callbacks that must keep a stable identity. */
  const activeTabRef = useRef(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  /**
   * Coarse status per chat tab, for its dot.
   *
   * Held here rather than in each pane because one extra state lives on top of
   * what a pane can know: a turn that ended while you were on another tab is
   * held at `pendingReview` until you look at it. The pane only ever says
   * "finished" — whether that is worth flagging depends on where you were.
   */
  const [tabStatus, setTabStatus] = useState<Record<string, string>>({});

  /** Stable per-tab onSessionId handlers, so ChatPane props never churn. */
  const sessionIdHandlersRef = useRef(new Map<string, (sessionId: string) => void>());
  const sessionIdHandlerFor = useCallback(
    (tabId: string) => {
      const handlers = sessionIdHandlersRef.current;
      let handler = handlers.get(tabId);
      if (!handler) {
        handler = (sessionId: string) => {
          handleSessionId(tabId, sessionId);
          if (tabId === activeTabRef.current) setLiveSessionId(sessionId);
        };
        handlers.set(tabId, handler);
      }
      return handler;
    },
    [handleSessionId],
  );

  /* ---------- tabs ---------- */

  /** Stable per-tab onStatus handlers, for the same reason as onSessionId. */
  const statusHandlersRef = useRef(new Map<string, (status: string) => void>());
  const statusHandlerFor = useCallback((tabId: string) => {
    const handlers = statusHandlersRef.current;
    let handler = handlers.get(tabId);
    if (!handler) {
      handler = (status: string) =>
        setTabStatus((current) => {
          const previous = current[tabId];
          // A turn that ended out of sight stays flagged. `pendingReview` counts
          // as live here so a second "finished" report cannot clear it.
          const wasLive =
            previous === "active" || previous === "awaiting" || previous === "pendingReview";
          const next =
            status === "finished" && wasLive && tabId !== activeTabRef.current
              ? "pendingReview"
              : status;
          return next === previous ? current : { ...current, [tabId]: next };
        });
      handlers.set(tabId, handler);
    }
    return handler;
  }, []);

  // Looking at a tab is what marks it read.
  useEffect(() => {
    if (!activeTab) return;
    setTabStatus((current) =>
      current[activeTab] === "pendingReview"
        ? { ...current, [activeTab]: "finished" }
        : current,
    );
  }, [activeTab]);

  /**
   * Every chat pane in the window, not just the active repo's.
   *
   * Filtering by `activeRepo` here unmounted the other repo's panes, and a pane
   * unmount is a transcript loss: `spawn` clears `items` and can only rehydrate
   * from `resumeFile`, which a fresh "New session" tab never has. The strip
   * (below) is what hides other repos; the panes stay mounted and keep
   * streaming, exactly as they already do across a tab switch.
   */
  const chatTabs = useMemo(
    () => tabs.filter((tab): tab is ChatTab => tab.kind === "chat"),
    [tabs],
  );

  /** Same treatment as `chatTabs`: these panes hold state worth keeping alive. */
  const fileTabs = useMemo(
    () =>
      tabs.filter(
        (tab): tab is Extract<Tab, { kind: "file" }> => tab.kind === "file",
      ),
    [tabs],
  );

  /* ---------- renaming ---------- */

  /** Fresh titles shown immediately, before the sidebar scan catches up. */
  const [titleOverrides, setTitleOverrides] = useState<Record<string, string>>({});
  /** Chat tab whose label is currently an input, with the draft text. */
  const [renaming, setRenaming] = useState<{
    id: string;
    sessionId: string;
    value: string;
  } | null>(null);
  /** Enter/Escape resolve the edit before the input's trailing blur fires;
      this flag stops that blur from committing (or resurrecting) the draft. */
  const renameDoneRef = useRef(false);

  // Drop overrides the scan has caught up with, so a later rename from
  // elsewhere (CLI `/rename`) is not shadowed by a stale local value.
  useEffect(() => {
    setTitleOverrides((current) => {
      let changed = false;
      const next = { ...current };
      for (const group of sessionGroups) {
        for (const session of group.sessions) {
          if (next[session.id] && session.title === next[session.id]) {
            delete next[session.id];
            changed = true;
          }
        }
      }
      return changed ? next : current;
    });
  }, [sessionGroups]);

  const commitRename = useCallback((sessionId: string, value: string) => {
    setRenaming(null);
    const title = value.trim();
    if (!title) return;
    setTitleOverrides((current) => ({ ...current, [sessionId]: title }));
    renameSession(sessionId, title).catch(() => {
      setTitleOverrides((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      setSystemMessage("rename failed: could not write the transcript");
    });
  }, []);

  /** A chat tab's label is its session title, resolved from the sidebar scan.
   *  Never the last prompt: a session is named by its `ai-title` (derived at
   *  start, upgraded by Haiku) or an explicit rename, nothing else. */
  const chatLabel = useCallback(
    (tab: ChatTab) => {
      if (!tab.sessionId) return "New session";
      const override = titleOverrides[tab.sessionId];
      if (override) return override;
      for (const group of sessionGroups) {
        const match = group.sessions.find((session) => session.id === tab.sessionId);
        if (match?.title) return match.title;
      }
      return tab.sessionId.slice(0, 8);
    },
    [sessionGroups, titleOverrides],
  );

  /** Focus the tab for this session, opening one if it is not already up. */
  const openSessionTab = useCallback((cwd: string, sessionId: string, file: string | null) => {
    setTabs((current) => {
      const existing = current.find(
        (tab) => tab.kind === "chat" && tab.sessionId === sessionId,
      );
      if (existing) {
        setActiveTab(existing.id);
        return current;
      }
      const tab: ChatTab = {
        kind: "chat",
        id: `chat|${cwd}|${sessionId}`,
        cwd,
        sessionId,
        resumeFile: file,
      };
      setActiveTab(tab.id);
      return [...current, tab];
    });
  }, []);

  const openNewChatTab = useCallback((cwd: string) => {
    const tab: ChatTab = {
      kind: "chat",
      id: `chat|${cwd}|new-${(newSessionCounter.current += 1)}`,
      cwd,
      sessionId: null,
      resumeFile: null,
    };
    setTabs((current) => [...current, tab]);
    setActiveTab(tab.id);
  }, []);

  // Every repo needs at least one chat tab, or switching to it shows nothing.
  useEffect(() => {
    if (!activeRepo) return;
    setTabs((current) => {
      const mine = current.filter((tab) => tab.kind === "chat" && tab.cwd === activeRepo);
      // A file, diff or dashboard tab belongs to no repo, so switching repos —
      // which the dashboard does when you click a row — must leave it in front.
      const repoIndependent = (id: string) =>
        current.some((tab) => tab.id === id && tab.kind !== "chat");
      if (mine.length > 0) {
        setActiveTab((active) =>
          repoIndependent(active) || mine.some((tab) => tab.id === active)
            ? active
            : mine[0].id,
        );
        return current;
      }
      const tab: ChatTab = {
        kind: "chat",
        id: `chat|${activeRepo}|new-${(newSessionCounter.current += 1)}`,
        cwd: activeRepo,
        sessionId: null,
        resumeFile: null,
      };
      setActiveTab((active) => (repoIndependent(active) ? active : tab.id));
      return [...current, tab];
    });
  }, [activeRepo]);

  const openFile = useCallback((path: string) => {
    setSelectedFile(path);
    const id = `file:${path}`;
    setTabs((current) =>
      current.some((tab) => tab.id === id)
        ? current
        : [...current, { id, kind: "file", label: path.split("/").pop() ?? path, path }],
    );
    setActiveTab(id);
  }, []);

  /**
   * Mirror of `dirtyFiles` for `closeTab`, which must see the current value
   * without being rebuilt — and so re-memoising every tab — on each keystroke.
   */
  const dirtyFilesRef = useRef(dirtyFiles);
  useEffect(() => {
    dirtyFilesRef.current = dirtyFiles;
  }, [dirtyFiles]);

  /** Stable, so the editor's reporting effect does not re-run per render. */
  const handleFileDirty = useCallback((path: string, dirty: boolean) => {
    setDirtyFiles((current) =>
      (current[path] ?? false) === dirty ? current : { ...current, [path]: dirty },
    );
  }, []);

  /**
   * Save functions published by the mounted editors, so the close guard can
   * offer to flush a buffer instead of only offering to drop it.
   */
  const fileSaversRef = useRef(new Map<string, () => Promise<boolean>>());
  const registerFileSave = useCallback(
    (path: string, save: (() => Promise<boolean>) | null) => {
      if (save) fileSaversRef.current.set(path, save);
      else fileSaversRef.current.delete(path);
    },
    [],
  );

  /** Focus the dashboard, opening it if this window has not yet. */
  const openDashboard = useCallback(() => {
    setTabs((current) =>
      current.some((tab) => tab.id === DASHBOARD_TAB)
        ? current
        : [...current, { id: DASHBOARD_TAB, kind: "dashboard", label: "Dashboard" }],
    );
    setActiveTab(DASHBOARD_TAB);
  }, []);

  const showDiff = useCallback((title: string, patch: string) => {
    const id = `diff:${title}`;
    setTabs((current) => {
      const existing = current.findIndex((tab) => tab.id === id);
      const tab: Tab = { id, kind: "diff", label: title.slice(0, 40), patch };
      if (existing === -1) return [...current, tab];
      const next = [...current];
      next[existing] = tab;
      return next;
    });
    setActiveTab(id);
  }, []);

  /* ---------- tab reordering ---------- */

  /**
   * Dragged tab id.
   *
   * State, not a ref: the dragged tab dims while it moves, and a ref write
   * would not paint that until some unrelated render happened to come along. It
   * changes twice per drag — on start and on end — so the renders are free.
   */
  const [dragTab, setDragTab] = useState<string | null>(null);
  /** Read inside the drag handlers, which must see the id set moments earlier. */
  const dragTabRef = useRef<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; side: "before" | "after" } | null>(
    null,
  );

  /** Move `fromId` to sit before or after `toId`. Keyed by id, not index: the
   *  splice that removes the dragged tab shifts every index after it. */
  const moveTab = useCallback(
    (fromId: string, toId: string, side: "before" | "after") => {
      if (fromId === toId) return;
      setTabs((current) => {
        const from = current.findIndex((tab) => tab.id === fromId);
        if (from === -1) return current;
        const next = [...current];
        const [moved] = next.splice(from, 1);
        const to = next.findIndex((tab) => tab.id === toId);
        if (to === -1) return current;
        next.splice(side === "before" ? to : to + 1, 0, moved);
        return next;
      });
    },
    [],
  );

  /** Which half of the tab the pointer is over, so a drop lands where it looks. */
  const dropSide = (event: React.DragEvent<HTMLDivElement>): "before" | "after" => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientX < box.left + box.width / 2 ? "before" : "after";
  };

  const endDrag = useCallback(() => {
    dragTabRef.current = null;
    setDragTab(null);
    setDropHint(null);
  }, []);

  /** Close without asking. Everything the close guard below decides to allow. */
  const forceCloseTab = useCallback(
    (id: string) => {
      statusHandlersRef.current.delete(id);
      sessionIdHandlersRef.current.delete(id);
      setTabStatus((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
      // Closing a chat is the one teardown that means "I am done with this" —
      // the pane's own unmount only detaches, because it also fires for tab and
      // repo switches. Without this the child outlives the tab, burning tokens
      // with nothing left to reach it. Outside the updater, which React may run
      // twice; the backend tolerates ids it does not know, so a dead chat is a
      // no-op either way.
      if (id.startsWith("chat|")) {
        void claudeKill(id).catch(() => {});
        // The pane's debug buffer keeps every frame it ever saw; the drawer's
        // clear button is the only other caller and it dies with the tab.
        clearDebug(id);
      }
      setTabs((current) => {
        const next = current.filter((tab) => tab.id !== id);
        if (activeTabRef.current !== id) return next;
        // Only a tab the strip shows is selectable: a chat from another repo is
        // filtered out of it, so focusing one leaves the centre pane blank.
        const selectable = next.filter(
          (tab) => tab.kind !== "chat" || tab.cwd === activeRepo,
        );
        // A file or dashboard tab is selectable but is not a chat: leaving the
        // repo with none of its own means no live session, so the seed below
        // has to run even when something else could hold focus.
        const chatSibling = selectable.find((tab) => tab.kind === "chat") ?? null;
        if (chatSibling || !activeRepo) {
          setActiveTab(chatSibling?.id ?? selectable[0]?.id ?? "");
          return next;
        }
        // Last chat of this repo: the seed effect only runs on a repo change,
        // so the replacement has to be made here or the centre stays blank.
        const fresh: ChatTab = {
          kind: "chat",
          id: `chat|${activeRepo}|new-${(newSessionCounter.current += 1)}`,
          cwd: activeRepo,
          sessionId: null,
          resumeFile: null,
        };
        setActiveTab(fresh.id);
        return [...next, fresh];
      });
    },
    [activeRepo],
  );

  /**
   * File tab whose close is waiting on an answer about its unsaved buffer.
   *
   * An in-app prompt rather than the dialog plugin's `ask`, which only has two
   * buttons: dropping edits, keeping them, and keeping the tab open are three
   * different answers, and collapsing any two of them loses work.
   */
  const [closePrompt, setClosePrompt] = useState<{ id: string; path: string } | null>(null);

  /** Close a tab, stopping first when that would silently drop unsaved edits. */
  const closeTab = useCallback(
    (id: string) => {
      const path = id.startsWith("file:") ? id.slice("file:".length) : null;
      if (path !== null && dirtyFilesRef.current[path]) {
        setClosePrompt({ id, path });
        return;
      }
      forceCloseTab(id);
    },
    [forceCloseTab],
  );

  /** "Save and close": the tab only goes if the write actually landed. */
  const saveAndCloseTab = useCallback(
    async (id: string, path: string) => {
      const save = fileSaversRef.current.get(path);
      setClosePrompt(null);
      // A save that failed — a conflict, a read-only file — leaves the tab up
      // with its editor showing why. Closing anyway would hide the reason.
      if (save && !(await save().catch(() => false))) return;
      forceCloseTab(id);
    },
    [forceCloseTab],
  );

  /* ---------- session switching ---------- */

  const resumeSessionFromSidebar = useCallback(
    async (session: SessionMeta) => {
      // A session belongs to the directory it was started in; follow it there so
      // the file tree and git panes stay in sync with the chat.
      const cwd = session.cwd
        ? (await gitRoot(session.cwd).catch(() => null)) ?? session.cwd
        : activeRepo;
      setActiveRepo(cwd);
      // Opening is idempotent: a session already up is focused, not respawned,
      // so two processes can never append to one transcript.
      openSessionTab(cwd, session.id, session.file);
    },
    [activeRepo, openSessionTab],
  );

  const startNewSession = useCallback(
    async (cwd: string) => {
      const root = (await gitRoot(cwd).catch(() => null)) ?? cwd;
      setActiveRepo(root);
      openNewChatTab(root);
    },
    [openNewChatTab],
  );

  // Switching repos from the picker also detaches the chat from its old session.
  const selectRepo = useCallback(
    async (path: string) => {
      // The sidebar passes a session's raw cwd and quick-open passes a repo root,
      // so both are normalised before comparing — a bare string compare misses
      // the sidebar path and tears down the chat you are currently using.
      const root = (await gitRoot(path).catch(() => null)) ?? path;
      if (root === activeRepo) return;
      // Tabs are per repo and stay mounted, so switching repos no longer tears
      // down a chat: the effect below just brings that repo's tabs forward.
      setActiveRepo(root);
    },
    [activeRepo],
  );

  /* ---------- keyboard ---------- */

  // The attached session's title lives in the scan, not in the chat stream.
  //
  // Authoritative on every exit, including the misses: bailing out early left
  // the previous session's title on the panel after switching to a session the
  // scan has not picked up yet, or to a fresh chat with no uuid at all.
  useEffect(() => {
    const match = liveSessionId
      ? sessionGroups.flatMap((group) => group.sessions).find((s) => s.id === liveSessionId)
      : undefined;
    setChatStats((current) => {
      const title = match?.title ?? null;
      // Seed the model from the scan so the panel is populated before the
      // first live turn; a real assistant frame overwrites it.
      const model = current.model ?? match?.model ?? null;
      if (current.title === title && current.model === model) return current;
      return { ...current, title, model };
    });
  }, [liveSessionId, sessionGroups]);

  /**
   * Back-fill `resumeFile` once the scan knows a fresh chat's transcript.
   *
   * A tab opened as "New session" has no path, so a remount of its pane had
   * nothing to rehydrate from. Panes no longer unmount on a repo switch, but a
   * restart or a future remount still needs the path to come back with history.
   */
  useEffect(() => {
    setTabs((current) => {
      let changed = false;
      const next = current.map((tab) => {
        if (tab.kind !== "chat" || !tab.sessionId || tab.resumeFile) return tab;
        const match = sessionGroups
          .flatMap((group) => group.sessions)
          .find((s) => s.id === tab.sessionId);
        if (!match) return tab;
        changed = true;
        return { ...tab, resumeFile: match.file };
      });
      return changed ? next : current;
    });
  }, [sessionGroups]);

  /* Void-returning wrappers with stable identities, so the memoized sidebar
     panes are not re-rendered by fresh inline arrows on every App render. */
  const handleSelectRepo = useCallback((path: string) => void selectRepo(path), [selectRepo]);
  const handleResume = useCallback(
    (session: SessionMeta) => void resumeSessionFromSidebar(session),
    [resumeSessionFromSidebar],
  );
  const handleNewSession = useCallback(
    (cwd: string) => void startNewSession(cwd),
    [startNewSession],
  );

  const currentTab = tabs.find((tab) => tab.id === activeTab);

  /** The chat tab in front, if the front tab is a chat at all. */
  const activeChat = currentTab?.kind === "chat" ? currentTab : null;

  // Follow the front tab, so the status panel describes what you are looking at.
  useEffect(() => {
    setLiveSessionId(activeChat?.sessionId ?? null);
  }, [activeChat?.sessionId]);

  /* ---------- menus ---------- */

  /** The file tab in front. What File ▸ Save acts on. */
  const activeFile = currentTab?.kind === "file" ? currentTab : null;

  const saveActiveFile = useCallback(() => {
    if (!activeFile) return;
    void fileSaversRef.current.get(activeFile.path)?.();
  }, [activeFile]);

  /** Ask for a directory. Cancelling resolves to null, which is not an error. */
  const pickDirectory = useCallback(
    async (title: string): Promise<string | null> => {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title,
        defaultPath: workspaceRoot || undefined,
      }).catch(() => null);
      return typeof picked === "string" ? picked : null;
    },
    [workspaceRoot],
  );

  const openRepoFromDisk = useCallback(async () => {
    const picked = await pickDirectory("Open repository");
    if (picked) await startNewSession(picked);
  }, [pickDirectory, startNewSession]);

  const pickWorkspaceRoot = useCallback(async () => {
    const picked = await pickDirectory("Workspace root to scan for repos");
    if (picked) setWorkspaceRoot(picked);
  }, [pickDirectory]);

  /** Only the tabs the strip is showing: "others" and "all" mean those. */
  const visibleTabs = useMemo(
    () => tabs.filter((tab) => tab.kind !== "chat" || tab.cwd === activeRepo),
    [tabs, activeRepo],
  );

  /**
   * Close every visible tab but one.
   *
   * Each goes through `closeTab`, so an unsaved editor still asks. The prompt
   * holds one tab at a time, so a second dirty file simply stays open — which is
   * the safe direction to fail in.
   */
  const closeTabsExcept = useCallback(
    (keepId: string | null) => {
      for (const tab of visibleTabs) {
        if (tab.id !== keepId) closeTab(tab.id);
      }
    },
    [visibleTabs, closeTab],
  );

  const startRename = useCallback((tabId: string, sessionId: string, label: string) => {
    renameDoneRef.current = false;
    setRenaming({ id: tabId, sessionId, value: label });
  }, []);

  /** What `tabMenu` needs; the menu's shape lives in `panes/menus.ts`. */
  const tabMenuContext = useMemo<TabMenuContext>(
    () => ({
      label: (tab) => (tab.kind === "chat" ? chatLabel(tab) : tab.label),
      visibleCount: visibleTabs.length,
      hasUnsavedChanges: (path) => Boolean(dirtyFiles[path]),
      activeRepo,
      onClose: closeTab,
      onCloseOthers: closeTabsExcept,
      onRename: startRename,
      onSave: (path) => void fileSaversRef.current.get(path)?.(),
      onNewSession: openNewChatTab,
    }),
    [
      chatLabel,
      visibleTabs.length,
      dirtyFiles,
      activeRepo,
      closeTab,
      closeTabsExcept,
      startRename,
      openNewChatTab,
    ],
  );

  /**
   * Every action, declared once.
   *
   * The chord string is the binding as well as the label — `runChord` parses the
   * same text the accelerator column prints — so a rename cannot leave the
   * keyboard answering the old one. `checked` and `disabled` live here too,
   * which is what lets a menu row and its keystroke agree about whether an
   * action is available at all.
   */
  const commands = useMemo<Command[]>(
    () => [
      {
        id: ID.newSession,
        label: "New Session",
        chord: CHORD.newSession,
        shellFirst: true,
        disabled: !activeRepo,
        run: () => activeRepo && openNewChatTab(activeRepo),
      },
      {
        id: ID.newTerminal,
        label: "New Terminal",
        chord: CHORD.newTerminal,
        run: () => {
          showTerminal();
          terminalActions.current?.newTab();
        },
      },
      {
        id: ID.openRecent,
        label: "Open Recent…",
        chord: CHORD.quickOpen,
        // A toggle, as the chord has always been: Ctrl+P closes the palette it
        // opened. The menu row reads as "open", and opening an open palette is
        // the one case where that differs — worth it to keep the chord honest.
        run: () => setQuickOpen((open) => !open),
      },
      { id: ID.openRepo, label: "Open Repository…", run: () => void openRepoFromDisk() },
      {
        id: ID.workspaceRoot,
        label: "Change Workspace Root…",
        run: () => void pickWorkspaceRoot(),
      },
      {
        id: ID.save,
        label: "Save",
        chord: CHORD.save,
        disabled: !activeFile || !dirtyFiles[activeFile.path],
        run: saveActiveFile,
      },
      {
        id: ID.closeTab,
        label: "Close Tab",
        chord: CHORD.closeTab,
        shellFirst: true,
        disabled: !activeTab,
        run: () => activeTab && closeTab(activeTab),
      },
      {
        id: ID.settings,
        label: "Settings…",
        chord: CHORD.settings,
        run: () => setSettingsOpen((open) => !open),
      },
      { id: ID.exit, label: "Exit", run: () => void closeWindow() },

      {
        id: ID.copyActivePath,
        label: "Copy Path of Active File",
        disabled: !activeFile,
        run: () => activeFile && void copyText(activeFile.path),
      },
      {
        id: ID.copySessionId,
        label: "Copy Session Id",
        disabled: !liveSessionId,
        run: () => liveSessionId && void copyText(liveSessionId),
      },

      ...ACTIVITY_ITEMS.map((item) => ({
        id: item.view === "explorer" ? ID.explorer : ID.sourceControl,
        label: item.label,
        chord: item.hint,
        checked: sidebarView === item.view && !leftCollapsed,
        run: () => {
          setSidebarView(item.view);
          setLeftCollapsed(false);
        },
      })),
      {
        id: ID.dashboard,
        label: "Dashboard",
        chord: CHORD.dashboard,
        checked: activeTab === DASHBOARD_TAB,
        run: openDashboard,
      },
      {
        id: ID.toggleSidebar,
        label: "Sidebar",
        chord: CHORD.toggleSidebar,
        checked: !leftCollapsed,
        run: () => setLeftCollapsed((collapsed) => !collapsed),
      },
      {
        id: ID.toggleTerminal,
        label: "Terminal Panel",
        chord: CHORD.toggleTerminal,
        checked: terminalVisible,
        run: toggleTerminal,
      },
      {
        id: ID.debugLog,
        label: "Session Debug Log",
        checked: debugOpen,
        disabled: !activeChat,
        run: () => setDebugOpen((open) => !open),
      },
      // One command per theme rather than a cycling toggle: the menu shows which
      // is active, and a radio group needs three addressable rows to do that.
      ...(["system", "light", "dark"] as Theme[]).map((option) => ({
        id: `view.theme.${option}`,
        label: option,
        checked: theme === option,
        run: () => {
          applyTheme(option);
          setTheme(option);
        },
      })),
      {
        id: ID.zoomIn,
        label: "Zoom In",
        chord: CHORD.zoomIn,
        run: () => setZoom((current) => stepZoom(current, 1)),
      },
      {
        id: ID.zoomOut,
        label: "Zoom Out",
        chord: CHORD.zoomOut,
        run: () => setZoom((current) => stepZoom(current, -1)),
      },
      {
        id: ID.zoomReset,
        // The live percentage is why this label is built here and not in the
        // menu module: the menus describe structure, not state.
        label: `Reset Zoom (${Math.round(zoom * 100)}%)`,
        chord: CHORD.zoomReset,
        disabled: zoom === DEFAULT_ZOOM,
        run: () => setZoom(DEFAULT_ZOOM),
      },
      {
        id: ID.fullScreen,
        label: "Full Screen",
        chord: CHORD.fullScreen,
        run: () => void toggleFullScreen(),
      },

      {
        id: ID.splitTerminal,
        label: "Split Terminal",
        chord: CHORD.splitTerminal,
        run: () => {
          showTerminal();
          terminalActions.current?.split();
        },
      },
      {
        id: ID.closeTerminalPane,
        label: "Close Terminal Pane",
        chord: CHORD.closeTerminal,
        run: () => terminalActions.current?.closePane(),
      },
      {
        id: ID.dockToggle,
        // Named for where it goes, not where it is — the same wording the
        // panel's own right-click uses, and a toggle like the chord always was.
        label: terminalDock === "right" ? "Move Terminal to the Bottom" : "Move Terminal to the Right",
        chord: CHORD.dockTerminal,
        run: () => setTerminalDock(terminalDock === "right" ? "bottom" : "right"),
      },

      {
        id: ID.shortcuts,
        label: "Keyboard Shortcuts",
        run: () => setShortcutsOpen(true),
      },
      { id: ID.documentation, label: "Documentation", run: () => void openExternal(REPO_URL) },
      { id: ID.reportIssue, label: "Report an Issue", run: () => void openExternal(ISSUES_URL) },
      { id: ID.about, label: "About mangouste", run: () => setAboutOpen(true) },
    ],
    [
      activeRepo,
      openNewChatTab,
      showTerminal,
      openRepoFromDisk,
      pickWorkspaceRoot,
      activeFile,
      dirtyFiles,
      saveActiveFile,
      activeTab,
      closeTab,
      liveSessionId,
      sidebarView,
      leftCollapsed,
      openDashboard,
      terminalVisible,
      toggleTerminal,
      debugOpen,
      activeChat,
      theme,
      zoom,
      terminalDock,
    ],
  );

  const barMenus = useMemo(() => buildBarMenus(commands), [commands]);
  const viewMenu = useCallback(() => viewEntries(commands), [commands]);

  /**
   * The one keyboard entry point.
   *
   * `runChord` walks the registry and parses the same chord string the menus
   * print, so there is no second copy of the matcher to drift from the labels.
   * Commands marked `shellFirst` are dropped when the keystroke landed in a
   * terminal, which is the whole of the readline exception.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const eligible = inTerminal(event)
        ? commands.filter((command) => !command.shellFirst)
        : commands;
      if (!runChord(eligible, event)) return;
      // Swallowed, not just defaulted: xterm listens on its own textarea, so an
      // unstopped Ctrl+Shift+T reaches the shell as a control byte as well as
      // opening a tab. Capture phase below is what gets us here first.
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [commands]);

  useEffect(() => {
    menu.setFallback(() => appEntries(commands));
    return () => menu.setFallback(null);
  }, [menu, commands]);

  return (
    <div className="app">
      <div
        className="titlebar"
        onContextMenu={(event) => menu.openContextMenu(event, ["app"])}
      >
        <MongooseLogo className="brand-logo" />
        <MenuBar menus={barMenus} />
        <button
          className="repo-button"
          onClick={() => setQuickOpen(true)}
          title="Open recent (Ctrl+P)"
        >
          {/* `pop()` on a split never returns undefined, only "" — so `||`. */}
          <span className="repo-name">{activeRepo.split("/").pop() || "select a repo"}</span>
          <span className="repo-hint">Ctrl+P</span>
        </button>
        <span className="spacer" />
        <button
          className="toggle-button"
          data-active={activeTab === DASHBOARD_TAB}
          onClick={openDashboard}
          title="Dashboard — all sessions, cost and tokens (Ctrl+Shift+D)"
        >
          dashboard
        </button>
        <button
          className="toggle-button"
          onClick={() => setSettingsOpen(true)}
          title="Settings (Ctrl+,)"
        >
          ⚙
        </button>
        <button
          className="toggle-button"
          data-active={terminalVisible}
          onClick={toggleTerminal}
          title="Toggle terminal (Ctrl+`)"
        >
          terminal
        </button>
      </div>

      <div className="workbench">
        {/* The rail sits outside the sidebar so it survives a collapse: it is
            what you click to bring the sidebar back. */}
        <div
          className="activity-bar"
          role="tablist"
          aria-label="Sidebar views"
          onContextMenu={(event) => menu.openContextMenu(event, viewMenu())}
        >
          {ACTIVITY_ITEMS.map(({ view, label, hint, Glyph }) => {
            const active = sidebarView === view && !leftCollapsed;
            return (
              <button
                key={view}
                className="activity-item"
                role="tab"
                aria-selected={active}
                aria-label={label}
                data-active={active}
                onClick={() => toggleSidebarView(view)}
                title={`${label} (${hint})`}
              >
                <Glyph />
              </button>
            );
          })}
        </div>

        <div
          className="sidebar"
          style={{
            width: leftCollapsed ? 0 : leftWidth,
            flex: `0 0 ${leftCollapsed ? 0 : leftWidth}px`,
            // Collapsed panes must not keep a tab stop or a visible border.
            display: leftCollapsed ? "none" : "flex",
          }}
        >
          {/* Both views stay mounted and the inactive one is hidden with
              `display`: unmounting the SCM pane would throw away a half-typed
              commit message and the loaded history on every glance at the
              tree, and remounting it re-runs the whole git read. */}
          <div
            className="sidebar-view"
            style={{ display: sidebarView === "explorer" ? "flex" : "none" }}
          >
            {activeRepo && (
              <PaneBoundary label="explorer">
                <FileTree root={activeRepo} onOpenFile={openFile} selectedPath={selectedFile} />
              </PaneBoundary>
            )}
          </div>
          <div
            className="sidebar-view"
            style={{ display: sidebarView === "git" ? "flex" : "none" }}
          >
            {activeRepo && (
              <PaneBoundary label="source control">
                <GitPane cwd={activeRepo} onShowDiff={showDiff} onOpenFile={openFile} />
              </PaneBoundary>
            )}
          </div>
        </div>

        {!leftCollapsed && <Resizer orientation="vertical" onDelta={resizeLeft} />}

        <div className="center-column">
          <div
            className="tab-strip"
            onContextMenu={(event) =>
              menu.openContextMenu(event, [
                activeRepo && {
                  label: "New Session in this Repo",
                  accelerator: CHORD.newSession,
                  run: () => openNewChatTab(activeRepo),
                },
                {
                  label: "Close All Tabs",
                  disabled: visibleTabs.length === 0,
                  run: () => closeTabsExcept(null),
                },
                "separator",
                "app",
              ])
            }
          >
            {tabs
              .filter((tab) => tab.kind !== "chat" || tab.cwd === activeRepo)
              .map((tab) => {
                const label = tab.kind === "chat" ? chatLabel(tab) : tab.label;
                return (
                  <div
                    key={tab.id}
                    className="tab"
                    data-kind={tab.kind}
                    data-active={tab.id === activeTab}
                    data-dragging={dragTab === tab.id}
                    data-drop={dropHint?.id === tab.id ? dropHint.side : undefined}
                    // Dragging owns mousedown, which would make selecting
                    // text inside the rename input impossible.
                    draggable={renaming?.id !== tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    onContextMenu={(event) => {
                      setActiveTab(tab.id);
                      menu.openContextMenu(event, tabMenu(tab, tabMenuContext));
                    }}
                    onAuxClick={(event) => {
                      // Middle-click closes, as in VSCode.
                      if (event.button === 1) {
                        event.preventDefault();
                        closeTab(tab.id);
                      }
                    }}
                    onDragStart={(event) => {
                      dragTabRef.current = tab.id;
                      setDragTab(tab.id);
                      event.dataTransfer.effectAllowed = "move";
                      // WebKitGTK will not begin a drag with an empty payload.
                      event.dataTransfer.setData("text/plain", tab.id);
                    }}
                    onDragOver={(event) => {
                      const dragging = dragTabRef.current;
                      if (!dragging || dragging === tab.id) return;
                      // Without preventDefault this is not a drop target and
                      // onDrop never fires at all.
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      const side = dropSide(event);
                      setDropHint((current) =>
                        current?.id === tab.id && current.side === side
                          ? current
                          : { id: tab.id, side },
                      );
                    }}
                    onDragLeave={() =>
                      setDropHint((current) => (current?.id === tab.id ? null : current))
                    }
                    onDrop={(event) => {
                      event.preventDefault();
                      const dragging = dragTabRef.current;
                      if (dragging) moveTab(dragging, tab.id, dropSide(event));
                      endDrag();
                    }}
                    onDragEnd={endDrag}
                    title={tab.kind === "file" ? tab.path : label}
                  >
                    {tab.kind === "chat" && (
                      <span
                        className="status-dot"
                        data-status={tabStatus[tab.id] ?? "idle"}
                        title={tabStatus[tab.id] ?? "idle"}
                      />
                    )}
                    {tab.kind === "file" && dirtyFiles[tab.path] && (
                      <span className="tab-dirty" title="Unsaved changes">
                        ●
                      </span>
                    )}
                    {renaming?.id === tab.id ? (
                      <input
                        className="tab-rename-input"
                        value={renaming.value}
                        autoFocus
                        onFocus={(event) => event.target.select()}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          setRenaming({ ...renaming, value: event.target.value })
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            renameDoneRef.current = true;
                            commitRename(renaming.sessionId, renaming.value);
                          } else if (event.key === "Escape") {
                            renameDoneRef.current = true;
                            setRenaming(null);
                          }
                        }}
                        onBlur={() => {
                          if (renameDoneRef.current) return;
                          commitRename(renaming.sessionId, renaming.value);
                        }}
                      />
                    ) : (
                      <span className="tab-label">{label}</span>
                    )}
                    {/* Renaming needs a transcript to write to, so a session
                        that has not announced its uuid yet has no pencil. */}
                    {tab.kind === "chat" && tab.sessionId && renaming?.id !== tab.id && (
                      <span
                        className="rename"
                        title="Rename session"
                        onClick={(event) => {
                          event.stopPropagation();
                          renameDoneRef.current = false;
                          setRenaming({ id: tab.id, sessionId: tab.sessionId!, value: label });
                        }}
                      >
                        <PencilIcon />
                      </span>
                    )}
                    <span
                      className="close"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTab(tab.id);
                      }}
                    >
                      ×
                    </span>
                  </div>
                );
              })}
            <button
              className="tab-new"
              onClick={() => activeRepo && openNewChatTab(activeRepo)}
              title="New session in this repo"
            >
              +
            </button>
          </div>

          <div
            className="center-body"
            ref={centerBody}
            // The one thing a dock change touches, besides which axis the stored
            // size applies to. The panel keeps its place among these children in
            // both directions, because React re-parenting it would unmount it and
            // its cleanup closes every pty behind it.
            style={{ flexDirection: terminalDock === "right" ? "row" : "column" }}
          >
            <div className="center-content">
              {/* Every chat tab stays mounted: hiding is not unmounting, so a turn
                  keeps streaming while you read another session. */}
              {chatTabs.map((tab) => (
                <div
                  key={tab.id}
                  style={{
                    display: tab.id === activeTab ? "flex" : "none",
                    flex: 1,
                    minHeight: 0,
                  }}
                >
                  <PaneBoundary label={chatLabel(tab)}>
                  <ChatPane
                    chatId={tab.id}
                    cwd={tab.cwd}
                    visible={tab.id === activeTab}
                    cold={coldTabs.has(tab.id)}
                    resume={tab.sessionId}
                    resumeFile={tab.resumeFile}
                    onSessionId={sessionIdHandlerFor(tab.id)}
                    onOpenFile={openFile}
                    onSystemMessage={setSystemMessage}
                    onPhase={tab.id === activeTab ? setPhase : noop}
                    onStatus={statusHandlerFor(tab.id)}
                    onStats={tab.id === activeTab ? handleChatStats : noop}
                    permissionMode={permissionMode}
                    model={modelAlias}
                    onModel={setModelAlias}
                  />
                  </PaneBoundary>
                </div>
              ))}

              {/* File tabs stay mounted for the same reason chat tabs do: unmounting
                  one would throw away an unsaved draft on a tab switch, silently.
                  `visible` is what keeps their Ctrl+S handlers from all firing. */}
              {fileTabs.map((tab) => (
                <div
                  key={tab.id}
                  style={{
                    display: tab.id === activeTab ? "flex" : "none",
                    flex: 1,
                    minHeight: 0,
                  }}
                >
                  <PaneBoundary label={tab.path}>
                    <FileView
                      path={tab.path}
                      visible={tab.id === activeTab}
                      onDirtyChange={handleFileDirty}
                      onRegisterSave={registerFileSave}
                    />
                  </PaneBoundary>
                </div>
              ))}
              {currentTab?.kind === "diff" && (
                <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                  <PaneBoundary label={currentTab.label}>
                    <DiffView patch={currentTab.patch} />
                  </PaneBoundary>
                </div>
              )}
              {currentTab?.kind === "dashboard" && (
                <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
                  <PaneBoundary label="dashboard">
                    <Dashboard
                      groups={sessionGroups}
                      onResume={handleResume}
                      onSelectRepo={handleSelectRepo}
                    />
                  </PaneBoundary>
                </div>
              )}
            </div>

            {terminalVisible && (
              <Resizer
                orientation={terminalDock === "right" ? "vertical" : "horizontal"}
                onDelta={dragTerminal}
              />
            )}
            {/* Hidden, never unmounted, and holding every repo's terminals at
                once: unmounting a pane runs its cleanup, which closes the pty and
                kills the shell, so neither Ctrl+` nor a repo switch may take a
                pane out of the tree. The toggle bumps `refitToken`, which re-runs
                fit() once the box has layout again. */}
            <TerminalPanel
              repo={activeRepo}
              visible={terminalVisible}
              size={terminalDock === "right" ? terminalWidth : terminalHeight}
              dock={terminalDock}
              refitToken={refitToken}
              themeKey={theme}
              onClose={hideTerminal}
              onRequestShow={showTerminal}
              onDock={setTerminalDock}
              onRegisterActions={registerTerminalActions}
            />
          </div>
        </div>

        <Resizer orientation="vertical" onDelta={(delta) => resizeRight(-delta)} />

        <div className="sidebar" style={{ width: rightWidth, flex: `0 0 ${rightWidth}px` }}>
          <PaneBoundary label="status">
            <StatusPanel groups={sessionGroups} cwd={activeRepo} stats={chatStats} />
          </PaneBoundary>
          <PaneBoundary label="sessions">
          <SessionsPane
            activeSessionId={liveSessionId}
            activeCwd={activeRepo}
            onGroups={handleGroups}
            onSelectRepo={handleSelectRepo}
            onResume={handleResume}
            onNewSession={handleNewSession}
          />
          </PaneBoundary>
        </div>
      </div>

      {settingsOpen && (
        <Settings
          theme={theme}
          onTheme={setTheme}
          permissionMode={permissionMode}
          onPermissionMode={setPermissionMode}
          restoreTabs={restoreTabs}
          onRestoreTabs={setRestoreTabs}
          workspaceRoot={workspaceRoot}
          onWorkspaceRoot={setWorkspaceRoot}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {closePrompt && (
        <div
          className="quickopen-scrim"
          onMouseDown={(event) => event.button === 0 && setClosePrompt(null)}
        >
          <div className="settings" onMouseDown={(event) => event.stopPropagation()}>
            <div className="pane-header">
              <span>Unsaved changes</span>
            </div>
            <p className="setting-hint" style={{ wordBreak: "break-all" }}>
              {closePrompt.path}
            </p>
            <div className="setting-row">
              <button
                className="toggle-button"
                onClick={() => void saveAndCloseTab(closePrompt.id, closePrompt.path)}
              >
                Save and close
              </button>
              <button
                className="toggle-button"
                onClick={() => {
                  forceCloseTab(closePrompt.id);
                  setClosePrompt(null);
                }}
              >
                Discard
              </button>
              <button className="toggle-button" onClick={() => setClosePrompt(null)}>
                Keep editing
              </button>
            </div>
          </div>
        </div>
      )}

      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}

      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}

      {quickOpen && (
        <QuickOpen
          groups={sessionGroups}
          repos={repos}
          onPick={(path) => {
            void selectRepo(path);
            setQuickOpen(false);
          }}
          onClose={() => setQuickOpen(false)}
        />
      )}

      {debugOpen && activeChat && (
        <DebugLog chatId={activeChat.id} onClose={() => setDebugOpen(false)} />
      )}

      <div
        className="statusbar"
        onContextMenu={(event) =>
          menu.openContextMenu(event, [
            activeRepo && {
              label: "Copy Repository Path",
              run: () => void copyText(activeRepo),
            },
            activeRepo && {
              label: "Reveal Repository",
              run: () => void revealPath(activeRepo),
            },
            liveSessionId && {
              label: "Copy Session Id",
              run: () => void copyText(liveSessionId),
            },
            activeChat && {
              label: "Session Debug Log",
              checked: debugOpen,
              run: () => setDebugOpen((open) => !open),
            },
            systemMessage && {
              label: "Dismiss Notice",
              run: () => setSystemMessage(null),
            },
            "separator",
            "app",
          ])
        }
      >
        <span>{activeRepo || "no repo"}</span>
        {liveSessionId && <span>session {liveSessionId.slice(0, 8)}</span>}
        {/* The technical answer to "why is nothing moving"; click for the
            full story — every frame, call and timing behind it. */}
        <span
          className="status-phase"
          data-phase={phase}
          data-clickable={Boolean(activeChat)}
          title={activeChat ? "Session debug log" : undefined}
          onClick={() => activeChat && setDebugOpen((open) => !open)}
        >
          {phase}
        </span>
        <span className="spacer" />
        {/* Process notices live here rather than in the transcript: they are
            about the CLI, not about the conversation. */}
        {systemMessage && (
          <span
            className="status-notice"
            title={systemMessage}
            onClick={() => setSystemMessage(null)}
          >
            {systemMessage}
          </span>
        )}
        <span>{repos.length} repos</span>
      </div>
    </div>
  );
}
