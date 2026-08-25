import { describe, expect, it } from "vitest";

import { CHORD, formatChord, macChord, resolveChords } from "./keybindings";
import { detectMac } from "./platform";
import { parseChord } from "./commands";

/**
 * The macOS keymap is derived, not written out, so what needs testing is the
 * derivation: that every chord it produces still parses, that the ones with a
 * reason to stay on Ctrl did, and that nothing arrives holding both modifiers by
 * accident.
 *
 * The table under test is built here rather than imported, because `CHORD` is
 * resolved once at import against the host the suite happens to run on.
 */
const MAC = resolveChords(CHORD, true);

describe("the macOS chord table", () => {
  it("moves Ctrl to Cmd", () => {
    expect(macChord("Ctrl+Shift+E")).toBe("Cmd+Shift+E");
    expect(macChord("Ctrl+`")).toBe("Cmd+`");
  });

  it("leaves a chord with no Ctrl alone", () => {
    expect(macChord("Shift+Enter")).toBe("Shift+Enter");
    expect(macChord("F10")).toBe("F10");
    expect(macChord("Middle-click")).toBe("Middle-click");
  });

  it("parses every chord it produces", () => {
    // Same guard as the Ctrl table's: a chord that cannot be parsed is printed
    // in the accelerator column and never fires.
    const prose = new Set(["", "Middle-click"]);
    const broken = Object.entries(MAC)
      .filter(([, chord]) => !prose.has(chord) && parseChord(chord) === null)
      .map(([name]) => name);
    expect(broken).toEqual([]);
  });

  it("keeps the terminal toggle on Ctrl, as the editors do", () => {
    expect(MAC.toggleTerminal).toBe("Ctrl+`");
  });

  it("does not leave a bare F-key where macOS has a media key", () => {
    expect(MAC.fullScreen).toBe("Ctrl+Cmd+F");
  });

  it("gives the terminal the platform's own copy and paste", () => {
    // Ctrl+Shift+C only exists to keep Ctrl+C for the shell. Cmd has no such
    // conflict, so the mechanical rename would have produced a chord nobody
    // presses.
    expect(MAC.terminalCopy).toBe("Cmd+C");
    expect(MAC.terminalPaste).toBe("Cmd+V");
  });

  it("drops the actions the platform has no concept of", () => {
    expect(MAC.primaryPaste).toBe("");
    // Middle-click still closes a tab; only the PRIMARY paste is gone.
    expect(MAC.closeTabAlt).toBe("Middle-click");
  });

  it("does not produce a chord holding both Ctrl and Cmd unintentionally", () => {
    const both = Object.entries(MAC)
      .map(([name, chord]) => [name, parseChord(chord)] as const)
      .filter(([, parsed]) => parsed?.ctrl && parsed?.meta)
      .map(([name]) => name);
    // Full screen is the one chord macOS itself spells with both.
    expect(both).toEqual(["fullScreen"]);
  });
});

describe("formatChord", () => {
  it("prints macOS modifiers as glyphs, in macOS order", () => {
    expect(formatChord("Cmd+Shift+E", true)).toBe("⇧⌘E");
    expect(formatChord("Ctrl+Cmd+F", true)).toBe("⌃⌘F");
    expect(formatChord("Cmd+Alt+P", true)).toBe("⌥⌘P");
  });

  it("names the keys macOS draws as glyphs", () => {
    expect(formatChord("Cmd+Enter", true)).toBe("⌘↩");
    expect(formatChord("Shift+Enter", true)).toBe("⇧↩");
    expect(formatChord("Escape", true)).toBe("⎋");
  });

  it("leaves prose and mouse gestures exactly as written", () => {
    expect(formatChord("Middle-click", true)).toBe("Middle-click");
    expect(formatChord("Select text", true)).toBe("Select text");
    expect(formatChord("F10", true)).toBe("F10");
    expect(formatChord("", true)).toBe("");
  });

  it("changes nothing off macOS", () => {
    expect(formatChord("Ctrl+Shift+E", false)).toBe("Ctrl+Shift+E");
    expect(formatChord("Ctrl+Enter", false)).toBe("Ctrl+Enter");
  });
});

describe("detectMac", () => {
  const WKWEBVIEW =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
  const WEBKITGTK =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

  it("recognises the mac webview by either signal", () => {
    expect(detectMac(WKWEBVIEW, "MacIntel")).toBe(true);
    expect(detectMac(WKWEBVIEW, "")).toBe(true);
    expect(detectMac("", "MacIntel")).toBe(true);
  });

  it("does not mistake WebKitGTK for it", () => {
    // Both webviews are WebKit and both say AppleWebKit, which is exactly the
    // trap: the engine name is not the platform.
    expect(detectMac(WEBKITGTK, "Linux x86_64")).toBe(false);
    expect(detectMac("", "")).toBe(false);
  });
});
