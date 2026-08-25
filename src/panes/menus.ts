/**
 * The menu bar's shape, and the shared blocks the context menus splice in.
 *
 * Structure only. Every row here names a command by id and takes its label,
 * chord, tick and handler from the registry `Workbench` builds — so this file
 * says *where* an action appears and never what it is or does. Moving it out of
 * `App.tsx` took ~230 lines of data out of a component that was already holding
 * the whole workbench's state.
 */

import { byId, commandEntry, type Command } from "../lib/commands";
import { copyText } from "../lib/editing";
import { revealPath } from "../lib/ipc";
import { CHORD } from "../lib/keybindings";
import type { MenuEntry } from "../lib/menuModel";
import { relativePath } from "../lib/paths";
import type { Tab } from "../lib/tabs";
import { themesOfKind } from "../lib/theme";
import type { BarMenu } from "./MenuBar";

/**
 * The vocabulary. `Workbench` builds a command for each of these, and everything
 * below refers to them by id, so a menu can never disagree with a keybinding
 * about what an action is called.
 */
export const ID = {
  newSession: "file.newSession",
  newWindow: "file.newWindow",
  newTerminal: "file.newTerminal",
  openRecent: "file.openRecent",
  openRepo: "file.openRepo",
  workspaceRoot: "file.workspaceRoot",
  save: "file.save",
  closeTab: "file.closeTab",
  settings: "file.settings",
  exit: "file.exit",

  formatDocument: "edit.formatDocument",
  copyActivePath: "edit.copyActivePath",
  copySessionId: "edit.copySessionId",

  explorer: "view.explorer",
  findReplace: "view.findReplace",
  sourceControl: "view.sourceControl",
  dashboard: "view.dashboard",
  toggleSidebar: "view.toggleSidebar",
  toggleTerminal: "view.toggleTerminal",
  debugLog: "view.debugLog",
  themeSystem: "view.theme.system",
  zoomIn: "view.zoomIn",
  zoomOut: "view.zoomOut",
  zoomReset: "view.zoomReset",
  fullScreen: "view.fullScreen",

  splitTerminal: "terminal.split",
  closeTerminalPane: "terminal.closePane",
  dockToggle: "terminal.dock",

  shortcuts: "help.shortcuts",
  documentation: "help.documentation",
  reportIssue: "help.reportIssue",
  about: "help.about",
} as const;

/** The command id that selects one theme. Shared with the registry in App. */
export const themeCommandId = (id: string): string => `view.theme.${id}`;

/** A row for one command. Overrides are for the rare label tweak in context. */
type Rows = readonly Command[];

const entry = (commands: Rows, id: string): MenuEntry => commandEntry(byId(commands, id));

/**
 * View, shared by the menu bar and a right-click on the activity rail.
 *
 * The theme and zoom rows are commands like everything else, which is what
 * keeps "Reset Zoom (125%)" — whose label carries live state — out of this file
 * entirely. The theme rows are generated from the same list the settings pane
 * reads, so adding a theme is a regeneration and not an edit here.
 */
export function viewEntries(commands: Rows): MenuEntry[] {
  return [
    entry(commands, ID.explorer),
    entry(commands, ID.findReplace),
    entry(commands, ID.sourceControl),
    entry(commands, ID.dashboard),
    "separator",
    entry(commands, ID.toggleSidebar),
    entry(commands, ID.toggleTerminal),
    entry(commands, ID.debugLog),
    "separator",
    {
      label: "Color Theme",
      items: [
        entry(commands, ID.themeSystem),
        "separator",
        ...themesOfKind("dark").map((theme) => entry(commands, themeCommandId(theme.id))),
        "separator",
        ...themesOfKind("light").map((theme) => entry(commands, themeCommandId(theme.id))),
      ],
    },
    {
      label: "Zoom",
      items: [
        entry(commands, ID.zoomIn),
        entry(commands, ID.zoomOut),
        entry(commands, ID.zoomReset),
      ],
    },
    entry(commands, ID.fullScreen),
  ];
}

/** Terminal, shared by the menu bar and the panel's own right-click. */
export function terminalEntries(commands: Rows): MenuEntry[] {
  return [
    entry(commands, ID.newTerminal),
    entry(commands, ID.splitTerminal),
    entry(commands, ID.closeTerminalPane),
    "separator",
    entry(commands, ID.dockToggle),
    "separator",
    entry(commands, ID.toggleTerminal),
  ];
}

/**
 * What the `"app"` sentinel expands to: the handful of actions worth reaching
 * from anywhere, including a right-click on a corner nothing else claims.
 */
export function appEntries(commands: Rows): MenuEntry[] {
  return [
    entry(commands, ID.openRecent),
    entry(commands, ID.newSession),
    "separator",
    entry(commands, ID.toggleSidebar),
    entry(commands, ID.toggleTerminal),
    "separator",
    entry(commands, ID.settings),
  ];
}

/**
 * The bar itself.
 *
 * Edit is a thunk because it is about whatever holds the caret, and focus moves
 * without any state changing — a snapshot taken at render time would describe
 * the wrong field. The rest are arrays: they read component state, and the
 * component re-renders when it changes.
 */
export function buildBarMenus(commands: Rows): BarMenu[] {
  return [
    {
      id: "file",
      label: "File",
      items: [
        entry(commands, ID.newSession),
        entry(commands, ID.newWindow),
        entry(commands, ID.newTerminal),
        "separator",
        entry(commands, ID.openRecent),
        entry(commands, ID.openRepo),
        entry(commands, ID.workspaceRoot),
        "separator",
        entry(commands, ID.save),
        entry(commands, ID.closeTab),
        "separator",
        entry(commands, ID.settings),
        entry(commands, ID.exit),
      ],
    },
    {
      id: "edit",
      label: "Edit",
      items: () => [
        "editing",
        "separator",
        entry(commands, ID.formatDocument),
        "separator",
        entry(commands, ID.copyActivePath),
        entry(commands, ID.copySessionId),
      ],
    },
    { id: "view", label: "View", items: viewEntries(commands) },
    { id: "terminal", label: "Terminal", items: terminalEntries(commands) },
    {
      id: "help",
      label: "Help",
      items: [
        entry(commands, ID.shortcuts),
        "separator",
        entry(commands, ID.documentation),
        entry(commands, ID.reportIssue),
        "separator",
        entry(commands, ID.about),
      ],
    },
  ];
}

/** What a tab's menu needs from the workbench that a command id cannot carry. */
export interface TabMenuContext {
  /** A chat tab's label is its session title, resolved by the caller. */
  label: (tab: Tab) => string;
  /** Tabs the strip is showing, which is what "others" and "all" mean. */
  visibleCount: number;
  hasUnsavedChanges: (path: string) => boolean;
  /** For "Copy Relative Path" and the new-session row. */
  activeRepo: string;
  onClose: (id: string) => void;
  /** `null` keeps nothing: that is "Close All". */
  onCloseOthers: (keepId: string | null) => void;
  onRename: (tabId: string, sessionId: string, label: string) => void;
  onSave: (path: string) => void;
  onNewSession: (cwd: string) => void;
}

/**
 * Right-click on a tab.
 *
 * Not built from command ids: every row here is about *this* tab, and a registry
 * command closes over the active one. The `sessionId`/`transcript` locals are
 * what let the closures narrow — `chat.sessionId` inside a callback is still
 * `string | null` however the entry above it is guarded.
 */
export function tabMenu(tab: Tab, ctx: TabMenuContext): MenuEntry[] {
  const label = ctx.label(tab);
  const chat = tab.kind === "chat" ? tab : null;
  const file = tab.kind === "file" ? tab : null;
  const sessionId = chat?.sessionId ?? null;
  const transcript = chat?.resumeFile ?? null;
  return [
    { header: label },
    { label: "Close", accelerator: CHORD.closeTab, run: () => ctx.onClose(tab.id) },
    {
      label: "Close Others",
      disabled: ctx.visibleCount < 2,
      run: () => ctx.onCloseOthers(tab.id),
    },
    { label: "Close All", run: () => ctx.onCloseOthers(null) },
    "separator",
    sessionId && {
      label: "Rename Session…",
      run: () => ctx.onRename(tab.id, sessionId, label),
    },
    sessionId && { label: "Copy Session Id", run: () => void copyText(sessionId) },
    chat && { label: "Copy Working Directory", run: () => void copyText(chat.cwd) },
    transcript && { label: "Reveal Transcript", run: () => void revealPath(transcript) },
    file && {
      label: "Save",
      accelerator: CHORD.save,
      disabled: !ctx.hasUnsavedChanges(file.path),
      run: () => ctx.onSave(file.path),
    },
    file && { label: "Copy Path", run: () => void copyText(file.path) },
    file && {
      // Relative to the tab's own repo, not the one in front: the two are the
      // same for a visible tab, and `file.cwd` cannot drift out of step with
      // whichever repo the strip is showing.
      label: "Copy Relative Path",
      run: () => void copyText(relativePath(file.cwd, file.path)),
    },
    file && { label: "Reveal in File Manager", run: () => void revealPath(file.path) },
    "separator",
    ctx.activeRepo && {
      label: "New Session in this Repo",
      accelerator: CHORD.newSession,
      run: () => ctx.onNewSession(ctx.activeRepo),
    },
  ];
}
