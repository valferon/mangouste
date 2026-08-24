import { describe, expect, it } from "vitest";
import {
  entriesAtLevel,
  expand,
  itemAt,
  step,
  tidy,
  type MenuEntry,
} from "./menuModel";

const item = (label: string, extra: Record<string, unknown> = {}) => ({ label, ...extra });

describe("tidy", () => {
  it("drops every falsy shape a conditional entry can produce", () => {
    // `""` is the one that bites: `activeRepo && {...}` yields it, not `false`.
    const entries: MenuEntry[] = [item("Keep"), null, false, undefined, "", item("Also")];
    expect(tidy(entries)).toEqual([item("Keep"), item("Also")]);
  });

  it("does not leave a rule where a collapsed block used to be", () => {
    const entries: MenuEntry[] = [item("Open"), "separator", null, null, "separator", item("Close")];
    expect(tidy(entries)).toEqual([item("Open"), "separator", item("Close")]);
  });

  it("strips leading and trailing rules", () => {
    expect(tidy(["separator", item("Only"), "separator"])).toEqual([item("Only")]);
  });

  it("collapses a run of rules to one", () => {
    expect(tidy([item("a"), "separator", "separator", "separator", item("b")])).toEqual([
      item("a"),
      "separator",
      item("b"),
    ]);
  });

  it("drops a submenu whose contents all collapsed, parent included", () => {
    // An empty popup is not a menu, and a parent that opens nothing is a dead
    // row the keyboard can still land on.
    const entries: MenuEntry[] = [item("Real"), item("Empty", { items: [null, false, ""] })];
    expect(tidy(entries)).toEqual([item("Real")]);
  });

  it("keeps a submenu that still has something in it, tidied", () => {
    const entries: MenuEntry[] = [
      item("Zoom", { items: ["separator", item("In"), null, "separator"] }),
    ];
    expect(tidy(entries)).toEqual([item("Zoom", { items: [item("In")] })]);
  });

  it("keeps headers, which are not actions but are not noise either", () => {
    expect(tidy([{ header: "file.ts" }, item("Open")])).toEqual([
      { header: "file.ts" },
      item("Open"),
    ]);
  });
});

describe("expand", () => {
  const expanders = {
    editing: (): MenuEntry[] => [item("Copy")],
    app: (): MenuEntry[] => [item("Settings")],
  };

  it("replaces each sentinel in place", () => {
    expect(expand([item("Close"), "separator", "editing"], expanders)).toEqual([
      item("Close"),
      "separator",
      item("Copy"),
    ]);
  });

  it("expands both sentinels, keeping their order", () => {
    expect(expand(["app", "editing"], expanders)).toEqual([item("Settings"), item("Copy")]);
  });

  it("reaches sentinels nested inside a submenu", () => {
    const out = expand([item("More", { items: ["editing"] })], expanders);
    expect(out).toEqual([item("More", { items: [item("Copy")] })]);
  });

  it("leaves the caller's array alone", () => {
    // The menus are rebuilt from component state; mutating the input would make
    // a second open of the same menu differ from the first.
    const input: MenuEntry[] = [item("Close"), "editing"];
    expand(input, expanders);
    expect(input).toEqual([item("Close"), "editing"]);
  });
});

describe("itemAt", () => {
  const entries: MenuEntry[] = [item("Open"), "separator", item("Gone", { disabled: true })];

  it("resolves an action by its raw position", () => {
    expect(itemAt(entries, 0)).toEqual(item("Open"));
  });

  it("refuses a rule, so a cursor cannot land on one", () => {
    expect(itemAt(entries, 1)).toBeNull();
  });

  it("refuses a disabled row", () => {
    expect(itemAt(entries, 2)).toBeNull();
  });

  it("refuses a position past the end", () => {
    expect(itemAt(entries, 99)).toBeNull();
  });
});

describe("step", () => {
  // Positions 1 and 3 are unselectable, so the cursor has to jump them.
  const entries: MenuEntry[] = [
    item("one"),
    "separator",
    item("two"),
    item("off", { disabled: true }),
    item("three"),
  ];

  it("skips rules and disabled rows going down", () => {
    expect(step(entries, 0, 1)).toBe(2);
    expect(step(entries, 2, 1)).toBe(4);
  });

  it("wraps from the last selectable row back to the first", () => {
    expect(step(entries, 4, 1)).toBe(0);
  });

  it("wraps backwards too", () => {
    expect(step(entries, 0, -1)).toBe(4);
  });

  it("finds the first row from the -1 the hover sentinel leaves behind", () => {
    expect(step(entries, -1, 1)).toBe(0);
  });

  it("reports -1 when nothing is selectable, rather than looping", () => {
    expect(step(["separator", { header: "x" }], -1, 1)).toBe(-1);
    expect(step([], -1, 1)).toBe(-1);
  });

  it("returns the only selectable row even when the cursor is already on it", () => {
    expect(step([item("only")], 0, 1)).toBe(0);
  });
});

describe("entriesAtLevel", () => {
  const tree: MenuEntry[] = [
    item("View", {
      items: [item("Appearance", { items: [item("dark")] }), item("Zoom")],
    }),
    item("Help"),
  ];

  it("returns the root at level 0", () => {
    expect(entriesAtLevel(tree, [0], 0)).toBe(tree);
  });

  it("walks the path into a submenu", () => {
    expect(entriesAtLevel(tree, [0, 1], 1)).toHaveLength(2);
    expect(entriesAtLevel(tree, [0, 0, 0], 2)).toEqual([item("dark")]);
  });

  it("returns nothing for a path through a row that has no submenu", () => {
    expect(entriesAtLevel(tree, [1, 0], 1)).toEqual([]);
  });

  it("returns nothing rather than throwing on a path past the end", () => {
    // Reachable transiently: the path is state, and the entries it indexes can
    // be rebuilt underneath it by a render.
    expect(entriesAtLevel(tree, [9, 9], 1)).toEqual([]);
  });
});
