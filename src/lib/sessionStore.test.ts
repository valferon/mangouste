import { describe, expect, it } from "vitest";
import { cleanFlags, cleanMarks, pinnedFirst } from "./sessionStore";

/**
 * These two guards stand between `localStorage` and every status dot in the
 * sessions rail. A mark with a missing `w` makes `lastActivityMs <= w` false
 * forever, which pins a session unread with no way to clear it from the UI.
 */
describe("cleanMarks", () => {
  const good = { w: 10, seenAt: 20, unread: 0 };

  it("keeps a well-formed mark", () => {
    expect(cleanMarks({ a: good })).toEqual({ a: good });
  });

  it("drops one bad entry without losing the others", () => {
    // The property that matters: corruption costs one row, not the whole store.
    const out = cleanMarks({ a: good, b: { w: 1 }, c: good });
    expect(Object.keys(out)).toEqual(["a", "c"]);
  });

  it("rejects marks whose fields are the wrong type", () => {
    expect(cleanMarks({ a: { w: "10", seenAt: 20, unread: 0 } })).toEqual({});
    expect(cleanMarks({ a: { w: null, seenAt: 20, unread: 0 } })).toEqual({});
  });

  it("rejects NaN and Infinity, which arithmetic would carry silently", () => {
    expect(cleanMarks({ a: { w: NaN, seenAt: 20, unread: 0 } })).toEqual({});
    expect(cleanMarks({ a: { w: Infinity, seenAt: 20, unread: 0 } })).toEqual({});
  });

  it("rejects non-objects sitting where a mark should be", () => {
    expect(cleanMarks({ a: null, b: 7, c: "x", d: [] })).toEqual({});
  });

  it("returns an empty map for an empty store", () => {
    expect(cleanMarks({})).toEqual({});
  });
});

describe("cleanFlags", () => {
  it("keeps booleans, both of them", () => {
    expect(cleanFlags({ a: true, b: false })).toEqual({ a: true, b: false });
  });

  it("drops anything that is not a boolean", () => {
    // Truthy strings are the trap: "false" would archive a row forever.
    expect(cleanFlags({ a: true, b: "false", c: 1, d: null })).toEqual({ a: true });
  });
});

/**
 * Pinning is the promise that a row stays where you can see it, so the two
 * properties worth holding are that pins come first and that nothing else moves.
 */
describe("pinnedFirst", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const pinnedIds = (ids: string[]) => (id: string) => ids.includes(id);

  it("hoists pinned rows, keeping the scan order within each half", () => {
    expect(pinnedFirst(rows, pinnedIds(["c", "b"])).map((r) => r.id)).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("returns the same array when nothing is pinned, so React sees no change", () => {
    expect(pinnedFirst(rows, pinnedIds([]))).toBe(rows);
  });

  it("leaves an all-pinned list in its original order", () => {
    expect(pinnedFirst(rows, pinnedIds(["a", "b", "c", "d"])).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});
