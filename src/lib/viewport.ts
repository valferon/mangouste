/**
 * Window and zoom actions, behind the capability calls that back them.
 *
 * All of these are refused unless `src-tauri/capabilities/default.json` grants
 * them, and a refusal arrives as a rejected promise — so every one swallows its
 * error: a menu item that cannot maximise the window must not take the app down
 * with it.
 */

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

const ZOOM_KEY = "mangouste.zoom";

/**
 * The zoom ladder, as in a browser.
 *
 * Discrete steps rather than a multiplier: repeated ×1.1 lands on factors that
 * put the monospace grid on half pixels, and the terminal canvas shows it.
 */
const ZOOM_STEPS = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export const DEFAULT_ZOOM = 1;

/** Remembered zoom, clamped to the ladder so a hand-edited value cannot stick. */
export function loadZoom(): number {
  const stored = Number(localStorage.getItem(ZOOM_KEY));
  if (!Number.isFinite(stored) || stored <= 0) return DEFAULT_ZOOM;
  return nearestZoom(stored);
}

function nearestZoom(factor: number): number {
  return ZOOM_STEPS.reduce((best, step) =>
    Math.abs(step - factor) < Math.abs(best - factor) ? step : best,
  );
}

/** One rung up or down from `factor`, stopping at the ends of the ladder. */
export function stepZoom(factor: number, direction: 1 | -1): number {
  const at = ZOOM_STEPS.indexOf(nearestZoom(factor));
  return ZOOM_STEPS[Math.min(Math.max(at + direction, 0), ZOOM_STEPS.length - 1)];
}

export async function applyZoom(factor: number): Promise<void> {
  localStorage.setItem(ZOOM_KEY, String(factor));
  try {
    await getCurrentWebview().setZoom(factor);
  } catch {
    // No zoom capability, or a platform that will not scale the webview.
  }
}

export async function toggleFullScreen(): Promise<void> {
  try {
    const window = getCurrentWindow();
    await window.setFullscreen(!(await window.isFullscreen()));
  } catch {
    // Nothing to do: the window keeps whatever state it had.
  }
}

/**
 * Close the window, which ends every `claude` it owns.
 *
 * The Rust side kills the children on `RunEvent::Exit`, so this is the same
 * path as the window manager's close button — not a shortcut around it.
 */
export async function closeWindow(): Promise<void> {
  try {
    await getCurrentWindow().close();
  } catch {
    /* ignored */
  }
}
