import { describe, expect, it } from "vitest";
import {
  FEEDBACK_DEFAULT,
  FEEDBACK_LEVELS,
  feedbackArgs,
  feedbackNeedsRestart,
  foldsThinking,
  namesIntent,
  opensTools,
  showsSubagents,
  type FeedbackLevel,
} from "./feedback";

describe("the feedback dial", () => {
  it("keeps the levels ordered from least to most, which is what the strip renders", () => {
    expect(FEEDBACK_LEVELS).toEqual(["quiet", "normal", "verbose"]);
  });

  it("defaults to the behaviour that needs no explanation", () => {
    expect(FEEDBACK_LEVELS).toContain(FEEDBACK_DEFAULT);
    expect(FEEDBACK_DEFAULT).toBe("normal");
  });

  it("only folds reasoning away at the quietest level", () => {
    expect(FEEDBACK_LEVELS.filter(foldsThinking)).toEqual(["quiet"]);
  });

  it("names intent everywhere except quiet", () => {
    expect(FEEDBACK_LEVELS.filter(namesIntent)).toEqual(["normal", "verbose"]);
  });

  it("opens calls and forwards subagents only at the loudest level", () => {
    expect(FEEDBACK_LEVELS.filter(opensTools)).toEqual(["verbose"]);
    expect(FEEDBACK_LEVELS.filter(showsSubagents)).toEqual(["verbose"]);
  });
});

describe("what a level asks of the CLI", () => {
  it("adds no flags below verbose, so quiet and normal cost nothing on the wire", () => {
    expect(feedbackArgs("quiet")).toEqual([]);
    expect(feedbackArgs("normal")).toEqual([]);
  });

  it("asks for subagent text at verbose", () => {
    expect(feedbackArgs("verbose")).toEqual(["--forward-subagent-text"]);
  });

  /* The strip's pending badge is this predicate. A level whose render half
     changed but whose flags did not must not claim it is waiting on a restart —
     that is the tooltip lying about work already done. */
  it("says a restart is needed only when the spawn flags actually differ", () => {
    expect(feedbackNeedsRestart("quiet", "normal")).toBe(false);
    expect(feedbackNeedsRestart("normal", "quiet")).toBe(false);
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
