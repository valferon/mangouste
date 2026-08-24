/**
 * One declaration per action, for the keyboard and the menus both.
 *
 * Before this there were three: a hand-coded matcher in the keydown handler
 * (`event.ctrlKey && event.shiftKey && event.key === "e"`), a display string in
 * `CHORD` ("Ctrl+Shift+E"), and a menu entry with its own copy of the label and
 * its own `run`. Nothing tied them together, so a chord could be renamed in the
 * menu while the handler kept answering the old one — and the menu would still
 * print the new name.
 *
 * Here the chord string *is* the binding: `matchChord` parses the same text the
 * accelerator column shows. Rename it once and both move.
 */

import type { MenuAction } from "./menuModel";

export interface Command {
  /** Stable id, so a menu can name a command instead of restating it. */
  id: string;
  label: string;
  /** Display text and binding, both. From `CHORD`; omit for menu-only actions. */
  chord?: string;
  /** Greyed and unrunnable, from either the keyboard or a menu. */
  disabled?: boolean;
  /** Renders a tick. */
  checked?: boolean;
  danger?: boolean;
  /**
   * The shell has a prior claim on this chord, so it stands down inside a
   * terminal. Ctrl+W is readline's delete-word and Ctrl+N is history-forward;
   * binding them window-wide would break both. Declared here rather than as a
   * list of exceptions in the key handler, so the reason travels with the
   * command.
   */
  shellFirst?: boolean;
  run: () => void;
}

/** Physical keys, so a chord means the same thing on every keyboard layout. */
const CODES: Record<string, string> = {
  "`": "Backquote",
  ",": "Comma",
  "=": "Equal",
  "-": "Minus",
  "/": "Slash",
  "\\": "Backslash",
  ".": "Period",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
};

/**
 * The `KeyboardEvent.code` a chord's final token names, or null if it names no
 * key at all — which is how "Middle-click" ends up in the same table as
 * "Ctrl+P" without ever matching a keystroke.
 *
 * `code` rather than `key` throughout, and for the same reason `TerminalPanel`
 * already reached for it: shifted digits arrive as `%` and `&` on most layouts,
 * so `Ctrl+Shift+5` compared against `key` never fires.
 */
function codeFor(token: string): string | null {
  if (/^[A-Za-z]$/.test(token)) return `Key${token.toUpperCase()}`;
  if (/^[0-9]$/.test(token)) return `Digit${token}`;
  if (/^F[0-9]{1,2}$/.test(token)) return token;
  if (token === "Enter" || token === "Escape" || token === "Tab" || token === "Space") {
    return token === "Space" ? "Space" : token;
  }
  return CODES[token] ?? null;
}

interface Chord {
  code: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** Parse "Ctrl+Shift+E". Returns null for anything that is not a key chord. */
export function parseChord(chord: string): Chord | null {
  const parts = chord.split("+").map((part) => part.trim());
  const key = parts.pop();
  if (!key) return null;
  const code = codeFor(key);
  if (code === null) return null;
  const chordKeys = { code, ctrl: false, shift: false, alt: false };
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case "ctrl":
      case "control":
        chordKeys.ctrl = true;
        break;
      case "shift":
        chordKeys.shift = true;
        break;
      case "alt":
        chordKeys.alt = true;
        break;
      default:
        // An unknown modifier must not silently widen the chord into one that
        // fires on fewer keys than it claims.
        return null;
    }
  }
  return chordKeys;
}

/**
 * Does this keystroke *exactly* match the chord?
 *
 * Exactly, including the modifiers the chord does not name: `Ctrl+N` must stay
 * off `Ctrl+Shift+N`, or two commands answer one keystroke. Meta is never part
 * of a chord here and never tolerated, so the desktop's own super-key bindings
 * pass through untouched.
 */
export function matchChord(chord: string, event: KeyboardEvent): boolean {
  const parsed = parseChord(chord);
  if (!parsed) return false;
  return (
    event.code === parsed.code &&
    event.ctrlKey === parsed.ctrl &&
    event.shiftKey === parsed.shift &&
    event.altKey === parsed.alt &&
    !event.metaKey
  );
}

/**
 * Run the first command this keystroke matches. `true` when one did.
 *
 * First, not all: two commands sharing a chord is a bug, and running both would
 * hide it behind whichever effect happened to be visible.
 */
export function runChord(commands: readonly Command[], event: KeyboardEvent): boolean {
  for (const command of commands) {
    if (command.disabled || !command.chord) continue;
    if (!matchChord(command.chord, event)) continue;
    command.run();
    return true;
  }
  return false;
}

/** A command as a menu row. The label, chord and state come along unchanged. */
export function commandEntry(command: Command, overrides: Partial<MenuAction> = {}): MenuAction {
  return {
    label: command.label,
    accelerator: command.chord,
    disabled: command.disabled,
    checked: command.checked,
    danger: command.danger,
    run: command.run,
    ...overrides,
  };
}

/** Look a command up by id. Throws, because a typo'd id is a bug, not a state. */
export function byId(commands: readonly Command[], id: string): Command {
  const found = commands.find((command) => command.id === id);
  if (!found) throw new Error(`no such command: ${id}`);
  return found;
}

/**
 * Every chord that answers more than one command.
 *
 * Called by the test rather than at runtime: the point is to fail a build, not
 * to warn a user about something they cannot fix.
 */
export function duplicateChords(commands: readonly Command[]): string[] {
  const seen = new Map<string, number>();
  for (const command of commands) {
    if (!command.chord) continue;
    seen.set(command.chord, (seen.get(command.chord) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([chord]) => chord);
}
