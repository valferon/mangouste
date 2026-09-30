/**
 * How tall the chat composer is, as one fact for the whole app.
 *
 * The same shape as `chatTimes.ts`, for the same reason: chat panes stay
 * mounted when their tab is behind, so a per-pane `useState` would leave every
 * other tab at the old height after a drag in the one in front. It lives in
 * `prefs`, not `state`, because it is a preference about how you write rather
 * than a fact about one window's layout: a second window picks it up too, via
 * the `storage` event that `localStorage` fires in every other window of the
 * origin.
 */

import { KEYS, readNumber, writeString } from "./persist";

/** What the composer was before it could be dragged: two lines and padding. */
export const COMPOSER_DEFAULT = 54;
export const COMPOSER_MIN = 54;
/**
 * A ceiling in pixels. The stylesheet adds a second one relative to the
 * viewport, so a height dragged on a large monitor cannot bury the log on a
 * laptop screen.
 */
export const COMPOSER_MAX = 600;

/**
 * A stored value as a height. Missing, zero, negative or not a number is the
 * default rather than a clamp up to the minimum, as in `usePersistentSize`.
 */
export function composerHeightFrom(stored: number): number {
  if (!Number.isFinite(stored) || stored <= 0) return COMPOSER_DEFAULT;
  return clamp(Math.round(stored));
}

function clamp(value: number): number {
  return Math.min(Math.max(value, COMPOSER_MIN), COMPOSER_MAX);
}

let height = composerHeightFrom(readNumber(KEYS.prefs.composerHeight, 0));
const listeners = new Set<() => void>();
let writeTimer: ReturnType<typeof setTimeout> | undefined;

function publish(next: number): boolean {
  if (next === height) return false;
  height = next;
  for (const listener of listeners) listener();
  return true;
}

export function composerHeight(): number {
  return height;
}

/**
 * Set the height, clamped, and persist it.
 *
 * Debounced like `usePersistentSize`: a drag is one call per pointer event, and
 * a synchronous storage write per frame is the expensive half of resizing.
 */
export function setComposerHeight(next: number): void {
  if (!publish(clamp(Math.round(next)))) return;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => writeString(KEYS.prefs.composerHeight, String(height)), 250);
}

/** Grow or shrink by a pointer delta. */
export function resizeComposer(delta: number): void {
  setComposerHeight(height + delta);
}

export function resetComposerHeight(): void {
  setComposerHeight(COMPOSER_DEFAULT);
}

export function subscribeComposerHeight(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Another window dragged its composer. Taken as-is and not written back, since
// that window already wrote it.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== KEYS.prefs.composerHeight) return;
    publish(composerHeightFrom(Number(event.newValue ?? 0)));
  });
}
