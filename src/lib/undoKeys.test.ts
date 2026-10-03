import { describe, expect, it, vi } from "vitest";
import { undoCommandFor } from "./undoKeys";

// The listener only runs off macOS, so read chords from the Linux keymap even
// when the suite runs on a Mac, where `CHORD` would resolve Ctrl to Cmd.
vi.mock("./platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platform")>()),
  isMac: () => false,
}));

/** Enough of a KeyboardEvent for `matchChord`, which reads five fields. */
function press(code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) {
  return {
    code,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: false,
  } as KeyboardEvent;
}

describe("undoCommandFor", () => {
  it("reads Ctrl+Z as undo", () => {
    expect(undoCommandFor(press("KeyZ", { ctrl: true }))).toBe("undo");
  });

  it("reads Ctrl+Shift+Z as redo", () => {
    expect(undoCommandFor(press("KeyZ", { ctrl: true, shift: true }))).toBe("redo");
  });

  it("leaves everything else alone", () => {
    expect(undoCommandFor(press("KeyZ"))).toBeNull();
    expect(undoCommandFor(press("KeyZ", { ctrl: true, alt: true }))).toBeNull();
    expect(undoCommandFor(press("KeyY", { ctrl: true }))).toBeNull();
  });
});
