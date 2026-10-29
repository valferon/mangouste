import { describe, expect, it } from "vitest";
import {
  FEEDBACK_DEFAULT,
  FEEDBACK_LEVELS,
  FEEDBACK_ARGS,
  opensTools,
  showsSubagents,
  tailsActivity,
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
  /* Switching levels must never respawn: there is no control request to start
     forwarding subagent text, so the flag rides every spawn and the level only
     decides what the pane renders. */
  it("forwards subagent text on every spawn, whatever the level", () => {
    expect(FEEDBACK_ARGS).toEqual(["--forward-subagent-text"]);
  });
});
