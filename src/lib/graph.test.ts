import { describe, expect, it } from "vitest";

import { layoutGraph, type GraphEdge } from "./graph";
import type { Commit } from "./types";

/** A commit is only its sha and its parents here; the rest never reaches the layout. */
function commit(sha: string, ...parents: string[]): Commit {
  return {
    sha,
    shortSha: sha,
    author: "t",
    authorEmail: "t@t",
    timestamp: 0,
    parents,
    refs: [],
    subject: sha,
  };
}

const of = (edges: GraphEdge[], kind: GraphEdge["kind"]) =>
  edges.filter((edge) => edge.kind === kind).map((edge) => `${edge.from}-${edge.to}`);

describe("layoutGraph", () => {
  it("keeps a straight history in one lane", () => {
    const rows = layoutGraph([commit("c", "b"), commit("b", "a"), commit("a")]);

    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(rows.map((row) => row.lanes)).toEqual([1, 1, 1]);
    expect(rows.every((row) => row.color === rows[0].color)).toBe(true);
    // The first row has nothing above it, the last nothing below.
    expect(of(rows[0].edges, "in")).toEqual([]);
    expect(of(rows[1].edges, "in")).toEqual(["0-0"]);
    expect(of(rows[2].edges, "out")).toEqual([]);
  });

  it("gives a second tip its own lane and colour", () => {
    const rows = layoutGraph([commit("x", "a"), commit("y", "a"), commit("a")]);

    expect(rows[0].lane).toBe(0);
    expect(rows[1].lane).toBe(1);
    expect(rows[0].color).not.toBe(rows[1].color);
    // Both lanes were waiting for `a`, so both end at its node and the right
    // one is freed rather than left drawn past the row that closed it.
    expect(of(rows[2].edges, "in").sort()).toEqual(["0-0", "1-0"]);
    expect(rows[2].lane).toBe(0);
  });

  it("sends a merge's second parent out to a lane of its own", () => {
    const rows = layoutGraph([
      commit("m", "p", "q"),
      commit("p", "r"),
      commit("q", "r"),
      commit("r"),
    ]);

    expect(of(rows[0].edges, "out")).toEqual(["0-0", "0-1"]);
    expect(rows[1].lane).toBe(0);
    expect(rows[2].lane).toBe(1);
    // Both sides converge on `r`, which is the point of drawing them apart.
    expect(of(rows[3].edges, "in").sort()).toEqual(["0-0", "1-0"]);
  });

  it("reuses the lane a closed branch gave back", () => {
    const rows = layoutGraph([
      commit("x", "a"),
      commit("y", "a"),
      commit("a", "b"),
      commit("b"),
    ]);

    // Lane 1 died with `a`; nothing below it should still be that wide.
    expect(rows.map((row) => row.lanes)).toEqual([1, 2, 2, 1]);
  });

  it("holds a lane open for a parent below the loaded page", () => {
    const rows = layoutGraph([commit("c", "b"), commit("b", "off-page")]);

    expect(rows[1].lanes).toBe(1);
    // The line leaves the bottom of the last row rather than stopping at it:
    // the history continues, the page does not.
    expect(of(rows[1].edges, "out")).toEqual(["0-0"]);
  });

  it("draws an octopus merge as one node with a lane per parent", () => {
    const rows = layoutGraph([commit("m", "a", "b", "c")]);

    expect(of(rows[0].edges, "out")).toEqual(["0-0", "0-1", "0-2"]);
    expect(rows[0].lanes).toBe(3);
  });

  it("has no rows for no commits", () => {
    expect(layoutGraph([])).toEqual([]);
  });
});
