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
import { TerminalPanel } from "./panes/TerminalPanel";
import { DiffView, FileView } from "./panes/Viewer";
import { DebugLog } from "./panes/DebugLog";
import {
  claudeKill,
  discoverRepos,
  gitRoot,
  homeDir,
  renameSession,
} from "./lib/ipc";
import { clearDebug } from "./lib/debugLog";
import { FilesIcon, PencilIcon, SourceControlIcon } from "./lib/icons";
import { installPrimarySelectionBridge } from "./lib/primary";
import { SessionFlagsProvider } from "./lib/sessionFlagsContext";
import { applyTheme, loadTheme, type Theme } from "./lib/theme";
import type { ProjectGroup, RepoInfo, SessionMeta } from "./lib/types";

/** Where repos are discovered from, remembered between runs. */
const WORKSPACE_KEY = "mangouste.workspaceRoot";
const PERMISSION_MODE_KEY = "mangouste.permissionMode";
const MODEL_KEY = "mangouste.model";
const ACTIVE_REPO_KEY = "mangouste.activeRepo";
const SIDEBAR_VIEW_KEY = "mangouste.sidebarView";

/** The left sidebar shows one of these at a time. */
type SidebarView = "explorer" | "git";

/**
 * Shared no-op for callbacks handed to inactive panes.
 *
 * A fresh `() => {}` per render defeats every memo and effect dependency
 * downstream, which is what made all four Tauri listeners rebind per render.
 */
const noop = () => {};

/**
 * A chat tab is one `claude` process.
 *
 * Sessions in the same repo are separate tabs rather than one swapping pane, so
 * switching between them does not tear down a turn that is still streaming.
 */
interface ChatTab {
  kind: "chat";
  /** Unique tab id, and the chat id the backend routes events by. */
  id: string;
  cwd: string;
  /** Resume target. `null` until the CLI reports the uuid for a fresh session. */
  sessionId: string | null;
  /** Transcript path backing `sessionId`, for rendering history on open. */
  resumeFile: string | null;
}

type Tab =
  | ChatTab
  | { id: string; kind: "file"; label: string; path: string }
  | { id: string; kind: "diff"; label: string; patch: string }
  | { id: string; kind: "dashboard"; label: string };

/** Floor for the terminal panel, matching the size hook's own minimum. */
const TERMINAL_MIN_HEIGHT = 80;

/** Space the editor keeps above the terminal, however far the divider is dragged. */
const TERMINAL_EDITOR_FLOOR = 140;

/** There is one dashboard, so its tab has a fixed id rather than a minted one. */
const DASHBOARD_TAB = "dashboard";

export default function App() {
  const [workspaceRoot, setWorkspaceRoot] = useState<string>(
    () => localStorage.getItem(WORKSPACE_KEY) ?? "",
  );
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  /** Session groups lifted from the sidebar, so quick-open can rank by recency. */
  const [sessionGroups, setSessionGroups] = useState<ProjectGroup[]>([]);
  const [quickOpen, setQuickOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [permissionMode, setPermissionMode] = useState(
    () => localStorage.getItem(PERMISSION_MODE_KEY) ?? "acceptEdits",
  );
  /** `--model` alias new panes spawn with; "default" leaves the flag off. */
  const [modelAlias, setModelAlias] = useState(() => localStorage.getItem(MODEL_KEY) ?? "default");
  /** Live facts lifted out of the chat pane for the status panel. */
  const [chatStats, setChatStats] = useState<ChatStats>({
    sessionId: null,
    model: null,
    contextTokens: 0,
    costUsd: null,
    title: null,
  });
  const [activeRepo, setActiveRepo] = useState<string>(
    () => localStorage.getItem(ACTIVE_REPO_KEY) ?? "",
  );

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState("");
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

  const [terminalVisible, setTerminalVisible] = useState(true);
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
  const [sidebarView, setSidebarView] = useState<SidebarView>(() => {
    const stored = localStorage.getItem(SIDEBAR_VIEW_KEY);
    return stored === "git" || stored === "explorer" ? stored : "explorer";
  });
  useEffect(() => {
    localStorage.setItem(SIDEBAR_VIEW_KEY, sidebarView);
  }, [sidebarView]);
  const [refitToken, setRefitToken] = useState(0);

  /** Reveal the panel and refit it, for a terminal chord pressed while hidden. */
  const showTerminal = useCallback(() => {
    setTerminalVisible(true);
    setRefitToken((token) => token + 1);
  }, []);

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
  /** The column the terminal panel shares with the editor, for that clamp. */
  const centerColumn = useRef<HTMLDivElement>(null);

  /**
   * Largest panel height that still leaves the editor something.
   *
   * A stored height taller than the window used to push the panel straight past
   * the bottom of the workbench, which clips at the status bar — so the terminal
   * looked like it ran underneath it, with its last rows unreachable.
   */
  const terminalLimit = useCallback(() => {
    const column = centerColumn.current?.clientHeight ?? 0;
    return Math.max(TERMINAL_MIN_HEIGHT, column - TERMINAL_EDITOR_FLOOR);
  }, []);

  const dragTerminal = useCallback(
    (delta: number) => {
      const limit = terminalLimit();
      setTerminalHeight((current) =>
        Math.min(Math.max(current - delta, TERMINAL_MIN_HEIGHT), limit),
      );
      setRefitToken((token) => token + 1);
    },
    [terminalLimit, setTerminalHeight],
  );

  // Re-clamp when the window resizes, since the limit moves with it.
  useEffect(() => {
    const column = centerColumn.current;
    if (!column) return;
    const clamp = () => {
      const limit = terminalLimit();
      setTerminalHeight((current) => (current > limit ? limit : current));
    };
    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(column);
    return () => observer.disconnect();
  }, [terminalLimit, setTerminalHeight]);

  /* ---------- X11 selection behaviour ---------- */

  useEffect(() => installPrimarySelectionBridge(), []);

  // Stamp the stored theme before first paint so there is no dark/light flash.
  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => {
    localStorage.setItem(PERMISSION_MODE_KEY, permissionMode);
  }, [permissionMode]);

  useEffect(() => {
    localStorage.setItem(MODEL_KEY, modelAlias);
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
    localStorage.setItem(WORKSPACE_KEY, workspaceRoot);
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
    if (activeRepo) localStorage.setItem(ACTIVE_REPO_KEY, activeRepo);
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Ctrl+` toggles the panel, as in VSCode.
      if (event.ctrlKey && event.key === "`") {
        event.preventDefault();
        setTerminalVisible((visible) => !visible);
        setRefitToken((token) => token + 1);
      }
      if (event.ctrlKey && (event.key === "," || event.key === "<")) {
        event.preventDefault();
        setSettingsOpen((open) => !open);
      }
      if (event.ctrlKey && (event.key === "p" || event.key === "P")) {
        event.preventDefault();
        setQuickOpen((open) => !open);
      }
      if (event.ctrlKey && (event.key === "b" || event.key === "B")) {
        event.preventDefault();
        setLeftCollapsed((collapsed) => !collapsed);
      }
      if (event.ctrlKey && event.shiftKey && (event.key === "d" || event.key === "D")) {
        event.preventDefault();
        openDashboard();
      }
      // Ctrl+Shift+E / Ctrl+Shift+G pick a left view, as in VSCode. Picking one
      // while the sidebar is collapsed reveals it rather than doing nothing.
      if (event.ctrlKey && event.shiftKey && (event.key === "e" || event.key === "E")) {
        event.preventDefault();
        setSidebarView("explorer");
        setLeftCollapsed(false);
      }
      if (event.ctrlKey && event.shiftKey && (event.key === "g" || event.key === "G")) {
        event.preventDefault();
        setSidebarView("git");
        setLeftCollapsed(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openDashboard]);

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

  return (
    <SessionFlagsProvider>
      <div className="app">
      <div className="titlebar">
        <span className="brand">mangouste</span>
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
          onClick={() => {
            setTerminalVisible((visible) => !visible);
            setRefitToken((token) => token + 1);
          }}
          title="Toggle terminal (Ctrl+`)"
        >
          terminal
        </button>
      </div>

      <div className="workbench">
        <div
          className="sidebar"
          style={{
            width: leftCollapsed ? 0 : leftWidth,
            flex: `0 0 ${leftCollapsed ? 0 : leftWidth}px`,
            // Collapsed panes must not keep a tab stop or a visible border.
            display: leftCollapsed ? "none" : "flex",
          }}
        >
          <div className="sidebar-tabs" role="tablist">
            <button
              className="sidebar-tab"
              role="tab"
              aria-selected={sidebarView === "explorer"}
              data-active={sidebarView === "explorer"}
              onClick={() => setSidebarView("explorer")}
              title="Explorer (Ctrl+Shift+E)"
            >
              <FilesIcon />
              Explorer
            </button>
            <button
              className="sidebar-tab"
              role="tab"
              aria-selected={sidebarView === "git"}
              data-active={sidebarView === "git"}
              onClick={() => setSidebarView("git")}
              title="Source control (Ctrl+Shift+G)"
            >
              <SourceControlIcon />
              Source Control
            </button>
          </div>
          {/* Both views stay mounted and the inactive one is hidden with
              `display`: unmounting the SCM pane would throw away a half-typed
              commit message and the loaded history on every glance at the
              tree, and remounting it re-runs the whole git read. */}
          <div
            className="sidebar-view"
            style={{ display: sidebarView === "explorer" ? "flex" : "none" }}
          >
            {activeRepo && (
              <FileTree root={activeRepo} onOpenFile={openFile} selectedPath={selectedFile} />
            )}
          </div>
          <div
            className="sidebar-view"
            style={{ display: sidebarView === "git" ? "flex" : "none" }}
          >
            {activeRepo && <GitPane cwd={activeRepo} onShowDiff={showDiff} />}
          </div>
        </div>

        {!leftCollapsed && <Resizer orientation="vertical" onDelta={resizeLeft} />}

        <div className="center-column" ref={centerColumn}>
          <div className="tab-strip">
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
              <ChatPane
                chatId={tab.id}
                cwd={tab.cwd}
                visible={tab.id === activeTab}
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
              <FileView
                path={tab.path}
                visible={tab.id === activeTab}
                onDirtyChange={handleFileDirty}
                onRegisterSave={registerFileSave}
              />
            </div>
          ))}
          {currentTab?.kind === "diff" && (
            <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
              <DiffView patch={currentTab.patch} />
            </div>
          )}
          {currentTab?.kind === "dashboard" && (
            <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
              <Dashboard
                groups={sessionGroups}
                onResume={handleResume}
                onSelectRepo={handleSelectRepo}
              />
            </div>
          )}

          {terminalVisible && (
            <Resizer orientation="horizontal" onDelta={dragTerminal} />
          )}
          {/* Hidden, never unmounted, and holding every repo's terminals at
              once: unmounting a pane runs its cleanup, which closes the pty and
              kills the shell, so neither Ctrl+` nor a repo switch may take a
              pane out of the tree. The toggle bumps `refitToken`, which re-runs
              fit() once the box has layout again. */}
          <TerminalPanel
            repo={activeRepo}
            visible={terminalVisible}
            height={terminalHeight}
            refitToken={refitToken}
            themeKey={theme}
            onClose={() => setTerminalVisible(false)}
            onRequestShow={showTerminal}
          />
        </div>

        <Resizer orientation="vertical" onDelta={(delta) => resizeRight(-delta)} />

        <div className="sidebar" style={{ width: rightWidth, flex: `0 0 ${rightWidth}px` }}>
          <StatusPanel groups={sessionGroups} cwd={activeRepo} stats={chatStats} />
          <SessionsPane
            activeSessionId={liveSessionId}
            activeCwd={activeRepo}
            onGroups={handleGroups}
            onSelectRepo={handleSelectRepo}
            onResume={handleResume}
            onNewSession={handleNewSession}
          />
        </div>
      </div>

      {settingsOpen && (
        <Settings
          theme={theme}
          onTheme={setTheme}
          permissionMode={permissionMode}
          onPermissionMode={setPermissionMode}
          workspaceRoot={workspaceRoot}
          onWorkspaceRoot={setWorkspaceRoot}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {closePrompt && (
        <div className="quickopen-scrim" onMouseDown={() => setClosePrompt(null)}>
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

      <div className="statusbar">
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
    </SessionFlagsProvider>
  );
}
