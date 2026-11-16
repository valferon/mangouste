import { describe, expect, it } from "vitest";
import { EFFORT_LEVELS, effortArgs, effortOutcome, liveEffortSetting } from "./effort";

describe("the effort dial", () => {
  it("orders the levels from none to most, which is what the strip renders", () => {
    expect(EFFORT_LEVELS).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
  });

  it("spawns the levels the settings schema knows through --settings", () => {
    expect(effortArgs("high")).toEqual(["--settings", '{"effortLevel":"high"}']);
  });

  it("spawns max through --effort, which the settings schema has no word for", () => {
    expect(effortArgs("max")).toEqual(["--effort", "max"]);
  });

  it("passes nothing for default", () => {
    expect(effortArgs("default")).toEqual([]);
  });
});

describe("switching effort on a live session", () => {
  it("hands every level to the control channel, max included", () => {
    const named = EFFORT_LEVELS.filter((level) => level !== "default");
    expect(named.map(liveEffortSetting)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("clears the level for default, whatever the process was launched with", () => {
    expect(liveEffortSetting("default")).toBeNull();
  });
});

describe("what the session says after a switch", () => {
  it("is applied when it reports the level asked for", () => {
    expect(effortOutcome("max", "max")).toEqual({ kind: "applied", running: "max" });
    expect(effortOutcome("low", "low")).toEqual({ kind: "applied", running: "low" });
  });

  it("is applied for default, and names the level default resolved to", () => {
    expect(effortOutcome("default", "medium")).toEqual({ kind: "applied", running: "medium" });
  });

  it("is held when the session reports another level", () => {
    expect(effortOutcome("max", "xhigh")).toEqual({ kind: "held", running: "xhigh" });
    expect(effortOutcome("low", "high")).toEqual({ kind: "held", running: "high" });
  });

  it("takes the acknowledgement at its word when the session names no level", () => {
    for (const reported of [null, undefined, "", 42, "ultracode", "default"]) {
      expect(effortOutcome("max", reported)).toEqual({ kind: "applied", running: null });
      expect(effortOutcome("default", reported)).toEqual({ kind: "applied", running: null });
    }
  });
});
