/** Theme handling. `system` follows the desktop's light/dark preference. */

import { KEYS, readEnum, writeString } from "./persist";

export type Theme = "system" | "light" | "dark";

export const THEMES: readonly Theme[] = ["system", "light", "dark"];

const THEME_KEY = KEYS.prefs.theme;

export function loadTheme(): Theme {
  return readEnum(THEME_KEY, THEMES, "system");
}

/**
 * Apply a theme by stamping the root element.
 *
 * `system` deliberately removes the attribute rather than resolving it here, so
 * the `prefers-color-scheme` media query in the stylesheet stays authoritative
 * and the app follows the desktop live, without a listener.
 */
export function applyTheme(theme: Theme): void {
  writeString(THEME_KEY, theme);
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
}
