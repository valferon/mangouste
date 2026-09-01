import { describe, expect, it } from "vitest";

import { blameAge, blameAuthor, blameRows, blameTitle, isUncommitted } from "./blame";
import type { Blame, BlameCommit } from "./types";

const commit = (over: Partial<BlameCommit> = {}): BlameCommit => ({
  sha: "a".repeat(40),
  shortSha: "aaaaaaaa",
  author: "Ada",
  authorEmail: "ada@example.com",
  timestamp: 1_700_000_000,
  summary: "teach it to blame",
  ...over,
});

const zero = commit({ sha: "0".repeat(40), shortSha: "00000000", author: "Not Committed Yet" });

describe("isUncommitted", () => {
  it("recognises git's all-zero sha", () => {
    expect(isUncommitted("0".repeat(40))).toBe(true);
  });

  it("does not treat a sha that merely starts with zeros as uncommitted", () => {
    expect(isUncommitted(`0000000${"b".repeat(33)}`)).toBe(false);
  });

  it("is false for nothing at all", () => {
    expect(isUncommitted("")).toBe(false);
  });
});

describe("blameAuthor", () => {
  it("names the author", () => {
    expect(blameAuthor(commit())).toBe("Ada");
  });

  it("replaces git's sentence for an uncommitted line with a word", () => {
    expect(blameAuthor(zero)).toBe("Uncommitted");
  });
});

describe("blameAge", () => {
  const now = 1_700_000_000_000;

  it("counts in the largest unit that fits", () => {
    expect(blameAge(now / 1000 - 30, now)).toBe("30s");
    expect(blameAge(now / 1000 - 300, now)).toBe("5m");
    expect(blameAge(now / 1000 - 7200, now)).toBe("2h");
    expect(blameAge(now / 1000 - 3 * 86400, now)).toBe("3d");
    expect(blameAge(now / 1000 - 3 * 604800, now)).toBe("3w");
    expect(blameAge(now / 1000 - 3 * 2629800, now)).toBe("3mo");
    expect(blameAge(now / 1000 - 3 * 31557600, now)).toBe("3y");
  });

  it("never counts backwards for a commit dated in the future", () => {
    // Clock skew between the machine that committed and this one.
    expect(blameAge(now / 1000 + 600, now)).toBe("0s");
  });

  it("says nothing when there is no timestamp to age", () => {
    expect(blameAge(0, now)).toBe("");
  });
});

describe("blameTitle", () => {
  it("spells out the commit, the author and the date", () => {
    const title = blameTitle(commit());
    expect(title).toContain("aaaaaaaa teach it to blame");
    expect(title).toContain("Ada <ada@example.com>");
  });

  it("explains an uncommitted line instead of naming a commit", () => {
    expect(blameTitle(zero)).toContain("only in your working tree");
  });
});

describe("blameRows", () => {
  const blame = (lines: number[], commits: BlameCommit[]): Blame => ({ commits, lines });

  it("labels only the first line of a run by the same commit", () => {
    const older = commit({ sha: "b".repeat(40) });
    const rows = blameRows(blame([0, 0, 1, 0], [commit(), older]));
    expect(rows.map((row) => row.first)).toEqual([true, false, true, true]);
  });

  it("carries the commit for every line, labelled or not", () => {
    const rows = blameRows(blame([0, 0], [commit()]));
    expect(rows.map((row) => row.commit.shortSha)).toEqual(["aaaaaaaa", "aaaaaaaa"]);
  });

  it("drops a line whose commit is not in the table rather than guessing", () => {
    const rows = blameRows(blame([0, 7], [commit()]));
    expect(rows).toHaveLength(1);
  });

  it("relabels the line after a dropped one, which starts a run of its own", () => {
    const rows = blameRows(blame([0, 7, 0], [commit()]));
    expect(rows.map((row) => row.first)).toEqual([true, true]);
  });
});
