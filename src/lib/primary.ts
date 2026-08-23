/**
 * X11 middle-click paste, and X11 select-to-copy.
 *
 * WebKitGTK does not wire PRIMARY into webview-editable content, so both halves
 * of the X11 selection convention are reimplemented here:
 *
 *  - selecting text anywhere in the app publishes it to PRIMARY
 *  - middle-clicking an editable target inserts PRIMARY at the caret
 *
 * Both are installed once, at the document level, so every input and textarea
 * gets the behaviour without opting in.
 */

import { primaryGet, primarySet } from "./ipc";

/** Selections settle in bursts while dragging; only the settled value is published. */
const PUBLISH_DELAY_MS = 120;

/**
 * When to check whether claiming PRIMARY ate the highlight.
 *
 * The `SelectionClear` that WebKitGTK reacts to arrives from the X server after
 * `primary_set` has returned, so the check cannot be done on the reply itself.
 * Two attempts, because a busy X server can deliver the clear either side of a
 * single deadline; the repair is a no-op when the highlight is still there.
 */
const RESTORE_DELAYS_MS = [60, 250];

type Editable = HTMLInputElement | HTMLTextAreaElement;

function isEditable(target: EventTarget | null): target is Editable {
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
 * The manual splice is the fallback when it is unavailable.
 */
function insertAtCaret(element: Editable, text: string) {
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
 * Enough of the current selection to put it back if something clears it.
 *
 * Text fields and ordinary DOM text need different handles: an input exposes
 * offsets into its value, while page text only has a `Range`.
 */
type Snapshot =
  | { kind: "editable"; element: Editable; start: number; end: number; text: string }
  | { kind: "range"; range: Range; text: string }
  | null;

function snapshotSelection(): Snapshot {
  const active = document.activeElement;
  if (isEditable(active)) {
    const start = active.selectionStart ?? 0;
    const end = active.selectionEnd ?? 0;
    if (end > start) {
      return { kind: "editable", element: active, start, end, text: active.value.slice(start, end) };
    }
  }
  const selection = window.getSelection();
  const text = selection?.toString() ?? "";
  if (!text || !selection || selection.rangeCount === 0) return null;
  return { kind: "range", range: selection.getRangeAt(0).cloneRange(), text };
}

/** The selection as the user sees it now, for comparing against a snapshot. */
function currentSelection(): string {
  const active = document.activeElement;
  if (isEditable(active)) {
    const start = active.selectionStart ?? 0;
    const end = active.selectionEnd ?? 0;
    if (end > start) return active.value.slice(start, end);
  }
  return window.getSelection()?.toString() ?? "";
}

/**
 * Re-select `snapshot` if it has since been cleared.
 *
 * Taking ownership of PRIMARY makes X send `SelectionClear` to the previous
 * owner, and when that owner is our own webview WebKitGTK answers it by
 * dropping the visible highlight — so a selection un-highlighted itself the
 * instant it settled. `primary_set` skips the claim when PRIMARY already holds
 * the same text, which covers the common case; this covers the rest.
 *
 * Anything that moved on in the meantime is left alone: a user who has clicked
 * elsewhere, typed into the field, or re-rendered the node away does not want an
 * old highlight back.
 */
function restoreSelection(snapshot: Snapshot) {
  if (!snapshot) return;
  if (currentSelection() === snapshot.text) return;

  if (snapshot.kind === "editable") {
    const { element, start, end, text } = snapshot;
    if (!element.isConnected || document.activeElement !== element) return;
    if (element.value.slice(start, end) !== text) return;
    element.setSelectionRange(start, end);
    return;
  }

  const { range, text } = snapshot;
  if (!range.startContainer.isConnected || !range.endContainer.isConnected) return;
  if (range.toString() !== text) return;
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Install both halves of the PRIMARY bridge.
 *
 * Returns a teardown function so React StrictMode's double-invoke does not leave
 * duplicate listeners behind.
 */
export function installPrimarySelectionBridge(): () => void {
  let publishTimer: number | undefined;
  let lastPublished = "";

  const publishSelection = () => {
    window.clearTimeout(publishTimer);
    publishTimer = window.setTimeout(() => {
      const snapshot = snapshotSelection();
      const text = snapshot?.text ?? "";
      // Clearing a selection must not wipe PRIMARY — that is what X11 apps do.
      if (!text || text === lastPublished) return;
      lastPublished = text;
      void primarySet(text).then((claimed) => {
        // Nothing was taken from WebKitGTK, so nothing can have been cleared.
        if (!claimed) return;
        for (const delay of RESTORE_DELAYS_MS) {
          window.setTimeout(() => restoreSelection(snapshot), delay);
        }
      });
    }, PUBLISH_DELAY_MS);
  };

  // WebKitGTK no longer pastes PRIMARY on middle-click; it pastes CLIPBOARD,
  // which reads as a stray Ctrl+V. `preventDefault` on the mousedown does not
  // reliably stop it, so the resulting `paste` is cancelled by timestamp below.
  let middleDownAt = -Infinity;

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 1) return;
    middleDownAt = event.timeStamp;
    const target = event.target;
    if (!isEditable(target)) return;
    // Stop WebKit's own middle-click handling (autoscroll, or a duplicate paste).
    event.preventDefault();
    void primaryGet().then((text) => {
      if (text) insertAtCaret(target, text);
    });
  };

  // Middle-click also emits `auxclick`; swallow it so nothing double-handles.
  const onAuxClick = (event: MouseEvent) => {
    if (event.button === 1 && isEditable(event.target)) event.preventDefault();
  };

  /**
   * How long after a middle-mousedown a `paste` is still attributed to it.
   *
   * WebKit's paste follows the button press within a frame or two; a human
   * reaching for Ctrl+V cannot land inside this window, so a real keyboard
   * paste is never swallowed.
   */
  const MIDDLE_PASTE_WINDOW_MS = 300;

  const onPasteCapture = (event: ClipboardEvent) => {
    if (event.timeStamp - middleDownAt > MIDDLE_PASTE_WINDOW_MS) return;
    // PRIMARY was already inserted from the mousedown, and this paste carries
    // CLIPBOARD. Cancel it before React's own composer handler ever sees it.
    middleDownAt = -Infinity;
    event.preventDefault();
    event.stopPropagation();
  };

  // Any keystroke means the next paste is the keyboard's, not the mouse's.
  const forgetMiddleClick = () => {
    middleDownAt = -Infinity;
  };

  // Only settled selections are published. `selectionchange` fires throughout a
  // drag, so it used to claim PRIMARY mid-gesture — which is exactly when losing
  // the highlight is most disruptive. `mouseup` covers dragging and
  // double-click-to-word, `keyup` covers shift-arrow and select-all.
  document.addEventListener("mouseup", publishSelection);
  document.addEventListener("keyup", publishSelection);
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("auxclick", onAuxClick, true);
  document.addEventListener("paste", onPasteCapture, true);
  document.addEventListener("keydown", forgetMiddleClick, true);

  return () => {
    window.clearTimeout(publishTimer);
    document.removeEventListener("mouseup", publishSelection);
    document.removeEventListener("keyup", publishSelection);
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("auxclick", onAuxClick, true);
    document.removeEventListener("paste", onPasteCapture, true);
    document.removeEventListener("keydown", forgetMiddleClick, true);
  };
}

/** Read PRIMARY on demand, for components that handle middle-click themselves. */
export async function readPrimary(): Promise<string> {
  try {
    return await primaryGet();
  } catch {
    return "";
  }
}
