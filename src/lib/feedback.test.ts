import { describe, expect, it } from "vitest";
import {
  FEEDBACK_DEFAULT,
  FEEDBACK_LEVELS,
  feedbackArgs,
  feedbackNeedsRestart,
  opensTools,
  showsSubagents,
  tailsActivity,
  type FeedbackLevel,
} from "./feedback";

describe("the feedback dial", () => {
  it("keeps the levels ordered from least to most, which is what the strip renders", () => {
    expect(FEEDBACK_LEVELS).toEqual(["normal", "verbose"]);
  });

  it("defaults to the behaviour that needs no explanation", () => {
    expect(FEEDBACK_LEVELS).toContain(FEEDBACK_DEFAULT);
    expect(FEEDBACK_DEFAULT).toBe("normal");
  });

  it("opens calls and forwards subagents only at the loudest level", () => {
    expect(FEEDBACK_LEVELS.filter(opensTools)).toEqual(["verbose"]);
    expect(FEEDBACK_LEVELS.filter(showsSubagents)).toEqual(["verbose"]);
    expect(FEEDBACK_LEVELS.filter(tailsActivity)).toEqual(["verbose"]);
  });
});

describe("what a level asks of the CLI", () => {
  it("adds no flags below verbose, so normal costs nothing on the wire", () => {
    expect(feedbackArgs("normal")).toEqual([]);
  });

  it("asks for subagent text at verbose", () => {
    expect(feedbackArgs("verbose")).toEqual(["--forward-subagent-text"]);
  });

  /* The strip's pending badge is this predicate. A level whose render half
     changed but whose flags did not must not claim it is waiting on a restart —
     that is the tooltip lying about work already done. */
  it("says a restart is needed only when the spawn flags actually differ", () => {
    expect(feedbackNeedsRestart("normal", "verbose")).toBe(true);
    expect(feedbackNeedsRestart("verbose", "normal")).toBe(true);
  });

  it("never asks for a restart to stay where you are", () => {
    for (const level of FEEDBACK_LEVELS) {
      expect(feedbackNeedsRestart(level, level)).toBe(false);
    }
  });

  it("only ever emits flags the CLI documents for a stream-json print run", () => {
    const known = new Set(["--forward-subagent-text"]);
    const levels: FeedbackLevel[] = FEEDBACK_LEVELS;
    for (const level of levels) {
      for (const arg of feedbackArgs(level)) expect(known.has(arg)).toBe(true);
    }
  });
});
