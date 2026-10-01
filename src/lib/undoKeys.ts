/**
 * Ctrl+Z and Ctrl+Shift+Z inside text fields, on WebKitGTK.
 *
 * WebKitGTK keeps an undo stack for every field but binds no key to it: the
 * keystroke reaches the page, nothing calls `preventDefault`, and nothing
 * happens. GTK browsers wire the chord to the editing command themselves, and
 * so does this. `execCommand("undo")` walks the same native stack that typing,
 * `insertText`, Tab and Format Document all push onto, so nothing else changes.
 *
 * macOS gets these from the Edit menu's AppKit items (see `mac_menu` in
 * lib.rs), which is why the listener stands down there.
 */

import { matchChord } from "./commands";
import { isEditable } from "./editing";
import { CHORD } from "./keybindings";
import { isMac } from "./platform";

/** Which editing command this keystroke asks for, if any. */
export function undoCommandFor(event: KeyboardEvent): "undo" | "redo" | null {
  if (matchChord(CHORD.undo, event)) return "undo";
  if (matchChord(CHORD.redo, event)) return "redo";
  return null;
}

/** Install the listener. Returns its teardown, for StrictMode's double-invoke. */
export function installUndoKeys(): () => void {
  if (isMac()) return () => {};

  const onKeyDown = (event: KeyboardEvent) => {
    const command = undoCommandFor(event);
    if (!command) return;
    const target = event.target;
    if (!isEditable(target)) return;
    // xterm's input is a textarea too, and Ctrl+Z there is the shell's SIGTSTP.
    if (target.closest(".terminal-host")) return;
    event.preventDefault();
    document.execCommand(command);
  };

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
