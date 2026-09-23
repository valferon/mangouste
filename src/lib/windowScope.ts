/**
 * Which window this webview is, and everything that has to be told apart
 * because of it.
 *
 * A second window is another webview onto the same backend, and that backend
 * routes by ids the frontend mints: `pty_open` closes whatever it already holds
 * under the id it is handed, and `claude_start` *attaches* to a live chat under
 * a matching id rather than spawning. Both counters used to start at 1 with the
 * module, which is exactly right for one window and a collision for two — the
 * second window's first terminal would have killed the first window's, and its
 * first new session would have adopted the other's process.
 *
 * The same goes for `localStorage`, which is per origin and therefore shared:
 * two windows writing one `openTabs` key is one tab strip wearing two hats.
 *
 * So everything that is *this window's* — its layout, its ids — is scoped by
 * label here. What is the user's rather than the window's (theme, model,
 * permission mode, which sessions have been read) stays shared on purpose: a
 * preference chosen in one window is a preference.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";

/** Matches `windows::MAIN_WINDOW` in Rust, and `tauri.conf.json`. */
const MAIN = "main";

/** Matches `windows::LABEL_PREFIX` in Rust. */
const LABEL_PREFIX = "window-";

/**
 * One colour per window past the first.
 *
 * Mixed with the theme's accent rather than used raw, so a window keeps looking
 * like the theme it is drawn in and is still told apart at a glance — the status
 * bar is the accent bar, and which colour it is painted in is the cheapest
 * possible answer to "which window am I typing into". The main window keeps the
 * accent untouched: the window that has always been there should not change
 * colour because a second one was opened.
 */
const TINTS = ["#c2571f", "#1f7f63", "#6f4bd8", "#a82a4f", "#2a6fb8"];

/**
 * Suffix for a stored key belonging to `label`.
 *
 * Empty for the main window, so its keys are the ones every existing install
 * already wrote and one upgrade does not forget where the tabs were. Pure, for
 * its test.
 */
export function keySuffix(label: string): string {
  return label === MAIN ? "" : `.${label}`;
}

/**
 * A stored key as this window spells it.
 *
 * Pure over `label` so the mapping can be tested without a window behind it.
 */
export function scopeKey(key: string, label: string): string {
  return `${key}${keySuffix(label)}`;
}

let cached: string | undefined;

/**
 * This window's label: `main`, or `window-2` and up.
 *
 * A function rather than a constant, and guarded: the Tauri internals it reads
 * are absent in the test runner, where a module-scope read would throw on import
 * instead of in the one test that cares. Falling back to `main` there is the
 * right answer anyway — one window is what a test is.
 */
export function windowLabel(): string {
  if (cached !== undefined) return cached;
  try {
    cached = getCurrentWindow().label;
  } catch {
    cached = MAIN;
  }
  return cached;
}

/** True in the window `tauri.conf.json` declares — the one a launch opens. */
export function isMainWindow(): boolean {
  return windowLabel() === MAIN;
}

/**
 * A prefix for ids this window mints, unique across windows and stable within
 * one. Empty in the main window, so the ids it sends are the ones it always
 * sent — a shorter id in a log is worth more than a uniform one.
 */
export function idScope(): string {
  return isMainWindow() ? "" : `${windowLabel()}:`;
}

/** For tests: forget what was detected. */
export function resetWindowScopeCache(): void {
  cached = undefined;
}

/**
 * This window's number, as a person would count them: `main` is 1.
 *
 * Pure over the label for its test, and tolerant of a label it cannot parse —
 * a colour is not worth throwing over.
 */
export function windowNumber(label: string): number {
  if (!label.startsWith(LABEL_PREFIX)) return 1;
  const parsed = Number.parseInt(label.slice(LABEL_PREFIX.length), 10);
  return Number.isFinite(parsed) && parsed > 1 ? parsed : 1;
}

/**
 * The colour standing for `label`, as a CSS value.
 *
 * Usable anywhere a colour is: the status bar of the window itself, and the dot
 * in another window's rail marking the sessions this one is running. Labels
 * past the palette wrap rather than run out, which is the right failure for a
 * sixth window — two windows sharing a colour is a nuisance, an uncoloured one
 * is a hole.
 */
export function windowTint(label: string): string {
  if (label === MAIN) return "var(--accent)";
  const tint = TINTS[(windowNumber(label) - 2) % TINTS.length];
  return `color-mix(in srgb, ${tint} 62%, var(--accent))`;
}

/** How a window is named in the UI: "window 2", and "this window" for main. */
export function windowName(label: string): string {
  return label === MAIN ? "window 1" : `window ${windowNumber(label)}`;
}
