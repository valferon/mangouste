/**
 * Theme handling.
 *
 * A theme is one of VS Code's own colour themes, replicated token for token in
 * `themes.css` — see `scripts/gen-themes.mjs`, which reads them out of a VS Code
 * install rather than transcribing them. Picking one stamps its id on the root
 * element and every colour in the app follows; nothing is computed here.
 *
 * `system` is the absence of a choice: the attribute comes off and the
 * `prefers-color-scheme` media query in `themes.css` decides between Dark+ and
 * Light+. That is what lets the app track the desktop live, without a listener.
 */

import { KEYS, readString, writeString } from "./persist";
import { THEME_LIST, type ThemeInfo } from "./themeList";

/** A theme id from `THEME_LIST`, or `SYSTEM`. */
export type Theme = string;

export const SYSTEM = "system";

export { THEME_LIST, type ThemeInfo };

const BY_ID = new Map(THEME_LIST.map((theme) => [theme.id, theme]));

/**
 * What the settings that predate the theme list map onto.
 *
 * `light` and `dark` were the whole choice for every release up to this one, so
 * they are read rather than discarded — an upgrade lands on the palette that
 * install was already painting, not on a default.
 */
const LEGACY: Record<string, string> = {
  light: "light-plus",
  dark: "dark-plus",
};

export function themeInfo(theme: Theme): ThemeInfo | undefined {
  return BY_ID.get(theme);
}

/** Label for the current choice, for menus and hints. */
export function themeLabel(theme: Theme): string {
  return themeInfo(theme)?.label ?? "Follow desktop";
}

export function themesOfKind(kind: "dark" | "light"): readonly ThemeInfo[] {
  return THEME_LIST.filter((theme) => theme.kind === kind);
}

export function loadTheme(): Theme {
  const stored = readString(KEYS.prefs.theme, SYSTEM);
  const mapped = LEGACY[stored] ?? stored;
  return BY_ID.has(mapped) ? mapped : SYSTEM;
}

/**
 * Apply a theme by stamping the root element.
 *
 * An unknown id is treated as `system` rather than left stamped: a theme dropped
 * from the list between releases must not leave the app with no palette at all.
 */
export function applyTheme(theme: Theme): void {
  const resolved = BY_ID.has(theme) ? theme : SYSTEM;
  writeString(KEYS.prefs.theme, resolved);
  const root = document.documentElement;
  if (resolved === SYSTEM) {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", resolved);
  }
}
