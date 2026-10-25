import { describe, expect, it } from "vitest";
import {
  layoutTree,
  leaf,
  paneIds,
  removePane,
  resizeSplit,
  splitPane,
  type PaneNode,
} from "./terminalLayout";

describe("splitPane", () => {
  it("wraps a lone pane in a split along the asked direction", () => {
    const tree = splitPane(leaf("a"), "a", "b", "column");
    expect(tree).toMatchObject({ kind: "split", dir: "column" });
    expect(paneIds(tree)).toEqual(["a", "b"]);
  });

  it("joins a split that already runs the same way, halving the target", () => {
    const pair = splitPane(leaf("a"), "a", "b", "row");
    const tree = splitPane(pair, "b", "c", "row");
    expect(tree.kind === "split" && tree.children.map((child) => child.weight)).toEqual([
      1, 0.5, 0.5,
    ]);
    expect(paneIds(tree)).toEqual(["a", "b", "c"]);
  });

  it("nests a split across the other axis", () => {
    const pair = splitPane(leaf("a"), "a", "b", "row");
    const tree = splitPane(pair, "b", "c", "column");
    expect(tree.kind === "split" && tree.children[1]).toMatchObject({
      kind: "split",
      dir: "column",
    });
    expect(paneIds(tree)).toEqual(["a", "b", "c"]);
  });

  it("reaches a pane nested two levels down", () => {
    let tree: PaneNode = splitPane(leaf("a"), "a", "b", "row");
    tree = splitPane(tree, "b", "c", "column");
    tree = splitPane(tree, "c", "d", "row");
    expect(paneIds(tree)).toEqual(["a", "b", "c", "d"]);
  });

  it("leaves the tree alone for an unknown target", () => {
    const pair = splitPane(leaf("a"), "a", "b", "row");
    expect(splitPane(pair, "zz", "c", "row")).toBe(pair);
  });
});

describe("removePane", () => {
  it("returns null for the last pane", () => {
    expect(removePane(leaf("a"), "a")).toBeNull();
  });

  it("collapses a split left with one child, which keeps the split's weight", () => {
    let tree: PaneNode = splitPane(leaf("a"), "a", "b", "row");
    tree = splitPane(tree, "b", "c", "column");
    const pruned = removePane(tree, "c");
    expect(pruned).toEqual({
      ...tree,
      children: [leaf("a"), leaf("b")],
    });
  });

  it("merges a child split into a parent running the same way", () => {
    // row[a, column[b, row[c, d]]] → removing b leaves row[a, c, d].
    let tree: PaneNode = splitPane(leaf("a"), "a", "b", "row");
    tree = splitPane(tree, "b", "c", "column");
    tree = splitPane(tree, "c", "d", "row");
    const pruned = removePane(tree, "b");
    expect(pruned?.kind === "split" && pruned.dir).toBe("row");
    expect(pruned?.kind === "split" && pruned.children.every((c) => c.kind === "pane")).toBe(
      true,
    );
    expect(pruned && paneIds(pruned)).toEqual(["a", "c", "d"]);
    const weights = pruned?.kind === "split" ? pruned.children.map((c) => c.weight) : [];
    expect(weights).toEqual([1, 0.5, 0.5]);
  });
});

describe("resizeSplit", () => {
  it("moves weight between the two neighbours of a divider", () => {
    const pair = splitPane(leaf("a"), "a", "b", "row");
    const id = pair.kind === "split" ? pair.id : "";
    const moved = resizeSplit(pair, id, 1, 0.25);
    expect(moved.kind === "split" && moved.children.map((c) => c.weight)).toEqual([1.5, 0.5]);
  });

  it("clamps at the minimum share", () => {
    const pair = splitPane(leaf("a"), "a", "b", "row");
    const id = pair.kind === "split" ? pair.id : "";
    const moved = resizeSplit(pair, id, 1, 5);
    const weights = moved.kind === "split" ? moved.children.map((c) => c.weight) : [];
    expect(weights[1]).toBeCloseTo(0.16);
  });

  it("returns the same tree for an unknown split", () => {
    const pair = splitPane(leaf("a"), "a", "b", "row");
    expect(resizeSplit(pair, "nope", 1, 0.1)).toBe(pair);
  });
});

describe("layoutTree", () => {
  it("fills the unit square with one pane", () => {
    expect(layoutTree(leaf("a"))).toEqual({
      panes: [{ id: "a", x: 0, y: 0, w: 1, h: 1 }],
      dividers: [],
    });
  });

  it("places a nested split and its dividers", () => {
    let tree: PaneNode = splitPane(leaf("a"), "a", "b", "row");
    tree = splitPane(tree, "b", "c", "column");
    const { panes, dividers } = layoutTree(tree);
    expect(panes).toEqual([
      { id: "a", x: 0, y: 0, w: 0.5, h: 1 },
      { id: "b", x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { id: "c", x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ]);
    expect(dividers).toMatchObject([
      { dir: "row", index: 1, x: 0.5, y: 0, h: 1, extent: 1 },
      { dir: "column", index: 1, x: 0.5, y: 0.5, w: 0.5, extent: 1 },
    ]);
  });
});
