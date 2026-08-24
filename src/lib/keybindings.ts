/**
 * Every chord the app answers to, in one table.
 *
 * The menu bar's accelerator column, the context menus and the Help ▸ Keyboard
 * Shortcuts sheet all read from here, so a chord can only be renamed in one
 * place — the drift between a tooltip and the handler that used to implement it
 * is the whole reason this file exists. The handlers themselves still live where
 * the state they touch lives; this is the label, not the binding.
 */

export const CHORD = {
  menuBar: "F10",
  newSession: "Ctrl+N",
  quickOpen: "Ctrl+P",
  save: "Ctrl+S",
  closeTab: "Ctrl+W",
  settings: "Ctrl+,",

  undo: "Ctrl+Z",
  redo: "Ctrl+Shift+Z",
  cut: "Ctrl+X",
  copy: "Ctrl+C",
  paste: "Ctrl+V",
  selectAll: "Ctrl+A",

  explorer: "Ctrl+Shift+E",
  sourceControl: "Ctrl+Shift+G",
  dashboard: "Ctrl+Shift+D",
  toggleSidebar: "Ctrl+B",
  toggleTerminal: "Ctrl+`",
  zoomIn: "Ctrl+=",
  zoomOut: "Ctrl+-",
  zoomReset: "Ctrl+0",
  fullScreen: "F11",

  newTerminal: "Ctrl+Shift+T",
  splitTerminal: "Ctrl+Shift+5",
  closeTerminal: "Ctrl+Shift+W",
  dockTerminal: "Ctrl+Shift+M",
  terminalCopy: "Ctrl+Shift+C",
  terminalPaste: "Ctrl+Shift+V",

  send: "Enter",
  newline: "Shift+Enter",
  commit: "Ctrl+Enter",
  indent: "Tab",
  dismiss: "Escape",
  primaryPaste: "Middle-click",
  closeTabAlt: "Middle-click",
} as const;

export interface ShortcutGroup {
  title: string;
  rows: { keys: string; what: string }[];
}

/** What the Help sheet shows, grouped the way the workbench is laid out. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Workbench",
    rows: [
      { keys: CHORD.menuBar, what: "Open the menu bar, then walk it with the arrows" },
      { keys: CHORD.quickOpen, what: "Open a repo or recent session" },
      { keys: CHORD.newSession, what: "New session in the active repo" },
      { keys: CHORD.closeTab, what: "Close the tab in front" },
      { keys: CHORD.closeTabAlt, what: "Close a tab, on the tab itself" },
      { keys: CHORD.settings, what: "Settings" },
      { keys: CHORD.toggleSidebar, what: "Show or hide the left sidebar" },
      { keys: CHORD.explorer, what: "Explorer" },
      { keys: CHORD.sourceControl, what: "Source Control" },
      { keys: CHORD.dashboard, what: "Dashboard" },
      { keys: CHORD.fullScreen, what: "Full screen" },
      { keys: `${CHORD.zoomIn} / ${CHORD.zoomOut} / ${CHORD.zoomReset}`, what: "Zoom in, out, reset" },
    ],
  },
  {
    title: "Chat",
    rows: [
      { keys: CHORD.send, what: "Send the message" },
      { keys: CHORD.newline, what: "Newline without sending" },
      { keys: "/", what: "Slash commands" },
      { keys: "@", what: "Mention a file" },
      { keys: CHORD.dismiss, what: "Close the completion menu, or interrupt the turn" },
    ],
  },
  {
    title: "Editor",
    rows: [
      { keys: CHORD.save, what: "Save the file in front" },
      { keys: CHORD.indent, what: "Indent two spaces" },
      { keys: CHORD.undo, what: "Undo" },
      { keys: CHORD.redo, what: "Redo" },
    ],
  },
  {
    title: "Terminal",
    rows: [
      { keys: CHORD.toggleTerminal, what: "Show or hide the panel" },
      { keys: CHORD.newTerminal, what: "New terminal tab" },
      { keys: CHORD.splitTerminal, what: "Split the terminal tab" },
      { keys: CHORD.closeTerminal, what: "Close the terminal pane" },
      { keys: CHORD.dockTerminal, what: "Move the panel between the bottom and the right" },
      { keys: CHORD.terminalCopy, what: "Copy the selection" },
      { keys: CHORD.terminalPaste, what: "Paste" },
    ],
  },
  {
    title: "Source Control",
    rows: [{ keys: CHORD.commit, what: "Commit the staged changes" }],
  },
  {
    title: "X11 selection",
    rows: [
      { keys: "Select text", what: "Publishes to PRIMARY, as in every X11 app" },
      { keys: CHORD.primaryPaste, what: "Paste PRIMARY at the caret" },
      { keys: "Right-click", what: "Context menu for whatever is under the pointer" },
    ],
  },
];
