/**
 * Selection, clipboard and caret primitives.
 *
 * The webview's own editing commands are only half-wired under WebKitGTK — a
 * scripted `execCommand("paste")` reads nothing, and `navigator.clipboard` is
 * gated on a user gesture the menu no longer counts as — so everything that
 * crosses the clipboard boundary goes through the Rust commands instead. What
 * stays in `execCommand` is only what has to: the insertions and deletions that
 * would otherwise throw away the native undo stack.
 *
 * Shared by the context menus, the menu bar's Edit menu and the PRIMARY bridge.
 */

import { clipboardGet, clipboardSet } from "./ipc";

export type Editable = HTMLInputElement | HTMLTextAreaElement;

/** A field the caret can sit in. Read-only inputs and checkboxes are not. */
export function isEditable(target: EventTarget | null): target is Editable {
  return (
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && !target.readOnly && target.type !== "checkbox")
  );
}

/**
 * Insert `text` at the caret and fire an `input` event.
 *
 * `execCommand("insertText")` is deprecated but is the only path that keeps the
 * native undo stack intact, which is the whole point of VSCode-like editing.
 * The manual splice is the fallback when it is unavailable; React's onChange
 * still sees it, since it listens for the native `input` event.
 */
export function insertAtCaret(element: Editable, text: string) {
  element.focus();
  if (document.execCommand?.("insertText", false, text)) return;

  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? start;
  element.value = element.value.slice(0, start) + text + element.value.slice(end);
  const caret = start + text.length;
  element.setSelectionRange(caret, caret);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * The highlighted text, as seen from `target`.
 *
 * A field's own `selectionStart/End` rather than the document selection: a
 * textarea's highlight is invisible to `window.getSelection()` in WebKit.
 * Captured when a menu is built, never when an item runs — opening the menu can
 * be what clears the highlight the item was about.
 */
export function selectionAt(target: EventTarget | null): string {
  if (isEditable(target)) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    return end > start ? target.value.slice(start, end) : "";
  }
  return window.getSelection()?.toString() ?? "";
}

/** Put `text` on the clipboard. Empty strings are dropped, not written. */
export async function copyText(text: string): Promise<void> {
  if (!text) return;
  try {
    await clipboardSet(text);
  } catch {
    // Nothing to fall back to; the text is still selectable by hand.
  }
}

/** Copy the field's selection, then delete it, keeping one undo step. */
export async function cutFrom(element: Editable): Promise<void> {
  const start = element.selectionStart ?? 0;
  const end = element.selectionEnd ?? 0;
  if (end <= start) return;
  await copyText(element.value.slice(start, end));
  element.focus();
  if (document.execCommand?.("delete")) return;
  element.value = element.value.slice(0, start) + element.value.slice(end);
  element.setSelectionRange(start, start);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Insert the clipboard at the caret. */
export async function pasteInto(element: Editable): Promise<void> {
  try {
    const text = await clipboardGet();
    if (text) insertAtCaret(element, text);
  } catch {
    // An empty or image-only clipboard is not an error worth reporting here.
  }
}

/** Containers whose text a document-level Select All should stop at. */
const SELECTION_SCOPE =
  ".selectable, .markdown, .chat-log, .diff-view, .editor, .pane-body, .dashboard-body";

/**
 * Select everything in the field, or everything in the block that was clicked.
 *
 * Unscoped, this would select the whole workbench — every sidebar row and
 * status chip along with the text actually being read.
 */
export function selectAllIn(target: EventTarget | null): void {
  if (isEditable(target)) {
    target.focus();
    target.select();
    return;
  }
  const selection = window.getSelection();
  if (!selection) return;
  const scope =
    (target instanceof Element ? target.closest(SELECTION_SCOPE) : null) ?? document.body;
  const range = document.createRange();
  range.selectNodeContents(scope);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Undo/redo inside a field. Both need the caret to be in it first. */
export function undoIn(element: Editable): void {
  element.focus();
  document.execCommand?.("undo");
}

export function redoIn(element: Editable): void {
  element.focus();
  document.execCommand?.("redo");
}
