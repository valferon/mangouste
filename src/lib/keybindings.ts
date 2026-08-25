/**
 * Every chord the app answers to, in one table.
 *
 * The menu bar's accelerator column, the context menus and the Help ▸ Keyboard
 * Shortcuts sheet all read from here, so a chord can only be renamed in one
 * place — the drift between a tooltip and the handler that used to implement it
 * is the whole reason this file exists. The handlers themselves still live where
 * the state they touch lives; this is the label, not the binding.
 *
 * On macOS the table is rewritten once, at import: Ctrl becomes Cmd, because
 * that is what every editor on that platform means by these chords and because
 * Ctrl+letter there is already spoken for by the system's emacs bindings inside
 * text fields. The rewrite happens here rather than in the matcher so that a
 * chord is still one string that is both the binding and the label — `matchChord`
 * parses exactly what the accelerator column shows.
 */

import { isMac } from "./platform";

/** The chords as written for a PC keyboard. macOS reads them through `macChord`. */
const BASE_CHORD = {
  menuBar: "F10",
  newSession: "Ctrl+N",
  quickOpen: "Ctrl+P",
  save: "Ctrl+S",
  // What every editor this borrows its keymap from formats with, and free of
  // Ctrl on purpose: it needs no macOS spelling of its own.
  format: "Shift+Alt+F",
  closeTab: "Ctrl+W",
  settings: "Ctrl+,",

  undo: "Ctrl+Z",
  redo: "Ctrl+Shift+Z",
  cut: "Ctrl+X",
  copy: "Ctrl+C",
  paste: "Ctrl+V",
  selectAll: "Ctrl+A",

  explorer: "Ctrl+Shift+E",
  findReplace: "Ctrl+Shift+F",
  sourceControl: "Ctrl+Shift+G",
  dashboard: "Ctrl+Shift+D",
  toggleSidebar: "Ctrl+B",
  toggleTerminal: "Ctrl+`",
  toggleChat: "Ctrl+Shift+`",
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

type ChordName = keyof typeof BASE_CHORD;

/**
 * The chords whose macOS spelling is not a Ctrl→Cmd rename.
 *
 * An empty string means the action does not exist on macOS at all.
 */
const MAC_CHORD: Partial<Record<ChordName, string>> = {
  // Editors keep the terminal toggle on Ctrl on macOS too — Cmd+` is the
  // system's cycle-windows chord, and muscle memory here follows VS Code.
  toggleTerminal: "Ctrl+`",
  // Same key, one modifier along, so the pair still reads as a pair — and for
  // the same reason: Cmd+Shift+` is the system's cycle-windows-backwards.
  toggleChat: "Ctrl+Shift+`",
  // F11 is a brightness key on Apple keyboards without holding fn.
  fullScreen: "Ctrl+Cmd+F",
  // Cmd+Shift+5 is the system's screenshot recorder, which takes the keystroke
  // first; Cmd+\\ is what the editors split with on macOS anyway.
  splitTerminal: "Cmd+\\",
  // Ctrl+Shift+C/V only exist on Linux because Ctrl+C has to reach the shell.
  // Cmd is free of that constraint, so the terminal copies like everything else.
  terminalCopy: "Cmd+C",
  terminalPaste: "Cmd+V",
  // PRIMARY is X11's. Middle-click still closes a tab; it just pastes nothing.
  primaryPaste: "",
};

/** Mechanical rename: every Ctrl in a chord becomes Cmd. */
export function macChord(chord: string): string {
  return chord.replace(/\bCtrl\b/g, "Cmd");
}

/** The chord table as this platform spells it. Exported for its test. */
export function resolveChords(
  base: Record<ChordName, string>,
  mac: boolean,
): Record<ChordName, string> {
  const resolved = {} as Record<ChordName, string>;
  for (const name of Object.keys(base) as ChordName[]) {
    resolved[name] = mac ? MAC_CHORD[name] ?? macChord(base[name]) : base[name];
  }
  return resolved;
}

export const CHORD: Record<ChordName, string> = resolveChords(BASE_CHORD, isMac());

/* ---------- display ---------- */

/** ⌃⌥⇧⌘, in the order macOS prints them. */
const MAC_MODIFIER: Record<string, string> = {
  ctrl: "⌃",
  control: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
  cmd: "⌘",
  meta: "⌘",
};
const MAC_MODIFIER_ORDER = ["⌃", "⌥", "⇧", "⌘"];

/** Keys macOS draws as a glyph rather than a word. */
const MAC_KEY: Record<string, string> = {
  Enter: "↩",
  Escape: "⎋",
  Tab: "⇥",
  Space: "␣",
};

/**
 * A chord as this platform writes it.
 *
 * Display only — never fed back to `parseChord`, which reads the `CHORD` strings
 * themselves. On macOS "Cmd+Shift+E" prints as "⇧⌘E", because a mac user reading
 * "Cmd+Shift+E" has to translate it and a modifier printed in the wrong order
 * reads as a different app's shortcut.
 */
export function formatChord(chord: string, mac: boolean = isMac()): string {
  if (!mac || !chord) return chord;
  const parts = chord.split("+").map((part) => part.trim());
  const key = parts.pop() ?? "";
  const modifiers = parts.map((part) => MAC_MODIFIER[part.toLowerCase()]);
  // An unknown modifier means this is not a chord we understand — a mouse
  // gesture, or free text in the Help sheet. Leave it exactly as written.
  if (modifiers.some((symbol) => symbol === undefined)) return chord;
  modifiers.sort(
    (a, b) => MAC_MODIFIER_ORDER.indexOf(a!) - MAC_MODIFIER_ORDER.indexOf(b!),
  );
  return modifiers.join("") + (MAC_KEY[key] ?? key);
}

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
      { keys: CHORD.findReplace, what: "Find and replace across the repo" },
      { keys: CHORD.sourceControl, what: "Source Control" },
      { keys: CHORD.dashboard, what: "Dashboard" },
      { keys: CHORD.fullScreen, what: "Full screen" },
      { keys: `${CHORD.zoomIn} / ${CHORD.zoomOut} / ${CHORD.zoomReset}`, what: "Zoom in, out, reset" },
    ],
  },
  {
    title: "Chat",
    rows: [
      { keys: CHORD.toggleChat, what: "Show or hide the chat and its session panes" },
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
      { keys: CHORD.format, what: "Reformat the file with the repo's own formatter" },
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
  isMac()
    ? {
        title: "Selection",
        rows: [
          { keys: "Right-click", what: "Context menu for whatever is under the pointer" },
        ],
      }
    : {
        title: "X11 selection",
        rows: [
          { keys: "Select text", what: "Publishes to PRIMARY, as in every X11 app" },
          { keys: CHORD.primaryPaste, what: "Paste PRIMARY at the caret" },
          { keys: "Right-click", what: "Context menu for whatever is under the pointer" },
        ],
      },
];
