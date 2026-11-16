import { describe, expect, it } from "vitest";
import {
  followActive,
  makeSplit,
  MIN_SPLIT_SHARE,
  pairBeside,
  pruneSplit,
  resizeSplitShare,
  splitShown,
  type SplitKindOf,
} from "./sessionSplit";

const sessions = new Set(["a", "b", "c"]);
const files = new Set(["f", "g"]);
const showable = (id: string) => sessions.has(id);
const kindOf: SplitKindOf = (id) => (sessions.has(id) ? "chat" : files.has(id) ? "file" : null);

describe("splitShown", () => {
  it("shows the pair with either side in front", () => {
    const split = makeSplit("a", "b");
    expect(splitShown(split, "a", showable)).toBe(true);
    expect(splitShown(split, "b", showable)).toBe(true);
  });

  it("hides it behind a tab outside the pair", () => {
    expect(splitShown(makeSplit("a", "b"), "file:x", showable)).toBe(false);
  });

  it("hides it when a side cannot be shown, such as another repo's tab", () => {
    expect(splitShown(makeSplit("a", "elsewhere"), "a", showable)).toBe(false);
  });

  it("never shows a tab beside itself", () => {
    expect(splitShown(makeSplit("a", "a"), "a", showable)).toBe(false);
  });
});

describe("followActive", () => {
  it("swaps a picked session in on the side that had focus", () => {
    expect(followActive(makeSplit("a", "b"), "b", "c", kindOf)).toEqual(makeSplit("a", "c"));
    expect(followActive(makeSplit("a", "b"), "a", "c", kindOf)).toEqual(makeSplit("c", "b"));
  });

  it("leaves the pair alone when focus moves within it", () => {
    const split = makeSplit("a", "b");
    expect(followActive(split, "a", "b", kindOf)).toBe(split);
  });

  it("leaves the pair alone for a view tab", () => {
    const split = makeSplit("a", "b");
    expect(followActive(split, "a", "file:x", kindOf)).toBe(split);
  });

  it("leaves a pair that was not showing alone", () => {
    const split = makeSplit("a", "b");
    expect(followActive(split, "file:x", "c", kindOf)).toBe(split);
  });

  it("swaps a picked file in for the file side", () => {
    expect(followActive(makeSplit("a", "f"), "a", "g", kindOf)).toEqual(makeSplit("a", "g"));
    expect(followActive(makeSplit("a", "f"), "f", "g", kindOf)).toEqual(makeSplit("a", "g"));
  });

  it("swaps a picked session in for the session side, even from the file", () => {
    expect(followActive(makeSplit("a", "f"), "f", "c", kindOf)).toEqual(makeSplit("c", "f"));
  });

  it("leaves two sessions alone for a picked file", () => {
    const split = makeSplit("a", "b");
    expect(followActive(split, "a", "f", kindOf)).toBe(split);
  });

  it("passes null through", () => {
    expect(followActive(null, "a", "b", kindOf)).toBeNull();
  });
});

describe("pairBeside", () => {
  it("keeps the session on the left", () => {
    expect(pairBeside("a", "f", kindOf)).toEqual(makeSplit("a", "f"));
    expect(pairBeside("f", "a", kindOf)).toEqual(makeSplit("a", "f"));
  });

  it("keeps two sessions in the order they were opened", () => {
    expect(pairBeside("a", "b", kindOf)).toEqual(makeSplit("a", "b"));
  });
});

describe("pruneSplit", () => {
  it("drops the pair once a side is gone", () => {
    expect(pruneSplit(makeSplit("a", "gone"), showable)).toBeNull();
  });

  it("keeps the same object while both sides exist", () => {
    const split = makeSplit("a", "b");
    expect(pruneSplit(split, showable)).toBe(split);
  });
});

describe("resizeSplitShare", () => {
  it("moves the divider and clamps at both ends", () => {
    expect(resizeSplitShare(makeSplit("a", "b"), 0.1).share).toBeCloseTo(0.6);
    expect(resizeSplitShare(makeSplit("a", "b"), -1).share).toBe(MIN_SPLIT_SHARE);
    expect(resizeSplitShare(makeSplit("a", "b"), 1).share).toBe(1 - MIN_SPLIT_SHARE);
  });
});
