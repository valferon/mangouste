import { describe, expect, it } from "vitest";
import { indexPaths, scmStatus } from "./scmStatus";

describe("scmStatus", () => {
  it("turns the untracked pair into a word, not two question marks", () => {
    expect(scmStatus("??")).toEqual({ letter: "U", tone: "added", title: "Untracked" });
  });

  it("reads the index side first", () => {
    expect(scmStatus("M ").letter).toBe("M");
    expect(scmStatus("A ").tone).toBe("added");
    expect(scmStatus("R ").tone).toBe("renamed");
  });

  it("falls through to the worktree side when the index is clean", () => {
    expect(scmStatus(" M").letter).toBe("M");
    expect(scmStatus(" D").tone).toBe("deleted");
  });

  it("lets a conflict outrank both sides", () => {
    expect(scmStatus("UU").tone).toBe("conflict");
    expect(scmStatus("AU").tone).toBe("conflict");
    expect(scmStatus("DU").tone).toBe("conflict");
    expect(scmStatus("AA").tone).toBe("conflict");
  });

  it("marks ignored paths apart from untracked ones", () => {
    expect(scmStatus("!!").tone).toBe("ignored");
  });

  it("survives a short or unknown code", () => {
    expect(scmStatus("").letter).toBe("·");
    expect(scmStatus("ZZ").letter).toBe("·");
    expect(scmStatus("M").letter).toBe("M");
  });
});

describe("indexPaths", () => {
  it("is the path on the row for anything but a rename", () => {
    expect(indexPaths([{ path: "a.ts", originalPath: null }, { path: "b.ts", originalPath: null }])).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  /**
   * A staged rename is one row and two index entries. Unstaged by the path on
   * the row alone, the old name stayed staged as a deletion: "Unstage All"
   * left a row behind, and the next commit deleted the file and nothing else.
   */
  it("names both sides of a rename", () => {
    expect(indexPaths([{ path: "docs/y.md", originalPath: "docs/x.md" }])).toEqual([
      "docs/x.md",
      "docs/y.md",
    ]);
  });
});

