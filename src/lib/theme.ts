/** Theme handling. `system` follows the desktop's light/dark preference. */

export type Theme = "system" | "light" | "dark";

const THEME_KEY = "mangouste.theme";

export function loadTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

/**
 * Apply a theme by stamping the root element.
 *
 * `system` deliberately removes the attribute rather than resolving it here, so
 * the `prefers-color-scheme` media query in the stylesheet stays authoritative
 * and the app follows the desktop live, without a listener.
 */
export function applyTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme);
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
}
