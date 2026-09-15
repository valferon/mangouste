import { describe, expect, it } from "vitest";
import {
  countsLabel,
  filesInScope,
  sameChanges,
  scopeOptions,
  scopeSince,
  summaryLabel,
  totals,
} from "./changes";
import type { ChangedFile, SessionChanges } from "./types";

const NOW = Date.parse("2026-09-14T12:00:00Z");
const MINUTE = 60_000;

function file(path: string, adds: number | null, dels: number | null, touchedMs = NOW): ChangedFile {
  return {
    path,
    additions: adds,
    deletions: dels,
    untracked: false,
    lastTouchMs: touchedMs,
    touches: touchedMs === 0 ? 0 : 1,
  };
}

function changes(files: ChangedFile[]): SessionChanges {
  const additions = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
  const deletions = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);
  return {
    base: "abc1234",
    baseLabel: "HEAD",
    files,
    fileCount: files.length,
    additions,
    deletions,
    unchanged: 0,
    turnStartMs: 0,
  };
}

describe("scopeSince", () => {
  it("reads each scope off the clock it belongs to", () => {
    const clock = { turnStartMs: NOW - MINUTE, seenAtMs: NOW - 10 * MINUTE };
    expect(scopeSince("turn", clock)).toBe(NOW - MINUTE);
    expect(scopeSince("seen", clock)).toBe(NOW - 10 * MINUTE);
    // The whole session has no cutoff, however the clock reads.
    expect(scopeSince("session", clock)).toBe(0);
  });
});

describe("filesInScope", () => {
  it("keeps what was written after the cutoff", () => {
    const kept = file("src/new.ts", 10, 0, NOW - MINUTE);
    const old = file("src/old.ts", 4, 2, NOW - 30 * MINUTE);
    expect(filesInScope([kept, old], NOW - 5 * MINUTE)).toEqual([kept]);
  });

  it("keeps an undatable change in every scope", () => {
    // Written by a `sed` or a formatter: git saw it, the transcript cannot date
    // it, and dropping it would hide a real change to the code.
    const undated = file("src/generated.ts", 80, 80, 0);
    expect(filesInScope([undated], NOW)).toEqual([undated]);
  });

  it("returns everything, and a copy, when there is no cutoff", () => {
    const input = [file("a.ts", 1, 1)];
    const out = filesInScope(input, 0);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });
});

describe("totals", () => {
  it("adds up both columns and counts binaries apart", () => {
    const sum = totals([file("a.ts", 12, 3), file("b.png", null, null), file("c.ts", 1, 0)]);
    expect(sum).toEqual({ files: 3, additions: 13, deletions: 3, binary: 1 });
  });
});

describe("labels", () => {
  it("prints both columns, with a real minus", () => {
    expect(countsLabel(totals([file("a.ts", 124, 31)]))).toBe("+124 −31");
    // The absent half is information: a file that only grew says so.
    expect(countsLabel(totals([file("a.ts", 40, 0)]))).toBe("+40 −0");
  });

  it("says what an empty scope means rather than printing zeroes", () => {
    expect(summaryLabel(totals([]))).toBe("no changes");
  });

  it("counts one file in the singular and names binaries", () => {
    expect(summaryLabel(totals([file("a.ts", 2, 1)]))).toBe("1 file · +2 −1");
    expect(summaryLabel(totals([file("a.ts", 2, 1), file("b.png", null, null)]))).toBe(
      "2 files · +2 −1 · 1 binary",
    );
  });
});

describe("scopeOptions", () => {
  it("disables a scope whose clock is unknown, and says why", () => {
    const [turn, seen, session] = scopeOptions({ turnStartMs: 0, seenAtMs: 0 });
    expect(turn.disabled).toBe(true);
    expect(turn.title).toMatch(/No turn has started/);
    expect(seen.disabled).toBe(true);
    // The whole session is always answerable.
    expect(session.disabled).toBe(false);
  });

  it("enables them once the clock has both hands", () => {
    const options = scopeOptions({ turnStartMs: NOW, seenAtMs: NOW - MINUTE });
    expect(options.every((option) => !option.disabled)).toBe(true);
  });
});

describe("sameChanges", () => {
  it("holds a poll that changed nothing equal", () => {
    expect(sameChanges(changes([file("a.ts", 1, 2)]), changes([file("a.ts", 1, 2)]))).toBe(true);
  });

  it("sees a line count move, a new file, and a rebase under the baseline", () => {
    expect(sameChanges(changes([file("a.ts", 1, 2)]), changes([file("a.ts", 3, 2)]))).toBe(false);
    expect(
      sameChanges(changes([file("a.ts", 1, 2)]), changes([file("a.ts", 1, 2), file("b.ts", 1, 0)])),
    ).toBe(false);
    const rebased = { ...changes([file("a.ts", 1, 2)]), base: "def5678" };
    expect(sameChanges(changes([file("a.ts", 1, 2)]), rebased)).toBe(false);
  });

  it("sees a fresh write to a file whose line counts did not move", () => {
    // Two edits that cancel out still mean the session touched it again, and the
    // list is ordered by that.
    const before = changes([file("a.ts", 1, 1, NOW - MINUTE)]);
    const after = changes([file("a.ts", 1, 1, NOW)]);
    expect(sameChanges(before, after)).toBe(false);
  });

  it("treats null as its own value", () => {
    expect(sameChanges(null, null)).toBe(true);
    expect(sameChanges(null, changes([]))).toBe(false);
  });
});
