import { describe, expect, it } from "vitest";
import { undoCommandFor } from "./undoKeys";

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
