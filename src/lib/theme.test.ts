import { describe, expect, it, vi } from "vitest";
import { KEYS } from "./persist";
import { SYSTEM, THEME_LIST, loadTheme, themeLabel, themesOfKind } from "./theme";

// The palettes themselves are checked in scripts/gen-themes.mjs, which is the
// only place that holds them: themes.css is the sole home for the colours, so
// the app does not also carry 700 hex strings in its JS bundle. What is testable
// here is the list every menu and picker is built from, and the reading of what
// an older install stored.
describe("THEME_LIST", () => {
  it("offers both polarities and the themes people ask for by name", () => {
    expect(themesOfKind("dark").length).toBeGreaterThan(4);
    expect(themesOfKind("light").length).toBeGreaterThan(2);
    const ids = THEME_LIST.map((t) => t.id);
    expect(ids).toContain("dark-plus");
    expect(ids).toContain("light-plus");
    expect(ids).toContain("monokai");
    expect(ids).toContain("solarized-dark");
  });

  it("has unique ids", () => {
    expect(new Set(THEME_LIST.map((t) => t.id)).size).toBe(THEME_LIST.length);
  });
});

describe("loadTheme", () => {
  /** The same shape persist.test.ts stubs: no DOM in this suite. */
  const set = (value: string | null) => {
    const map = new Map<string, string>(value === null ? [] : [[KEYS.prefs.theme, value]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, next: string) => void map.set(key, next),
      removeItem: (key: string) => void map.delete(key),
    });
  };

  it("maps the settings that predate the theme list", () => {
    // An install upgrading from a build that only had light/dark/system lands on
    // the palette it was already painting, not on a default.
    set("dark");
    expect(loadTheme()).toBe("dark-plus");
    set("light");
    expect(loadTheme()).toBe("light-plus");
  });

  it("falls back to system for anything it does not recognise", () => {
    set("some-theme-a-newer-build-had");
    expect(loadTheme()).toBe(SYSTEM);
    set(null);
    expect(loadTheme()).toBe(SYSTEM);
  });

  it("round-trips a real id", () => {
    set("monokai");
    expect(loadTheme()).toBe("monokai");
  });
});

describe("themeLabel", () => {
  it("names the desktop-following choice too", () => {
    expect(themeLabel("monokai")).toBe("Monokai");
    expect(themeLabel(SYSTEM)).toBe("Follow desktop");
  });
});
