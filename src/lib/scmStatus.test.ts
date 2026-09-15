import { describe, expect, it } from "vitest";
import { scmStatus } from "./scmStatus";

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
