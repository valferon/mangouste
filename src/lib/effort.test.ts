import { describe, expect, it } from "vitest";
import { EFFORT_LEVELS, effortArgs, liveEffortSetting } from "./effort";

describe("the effort dial", () => {
  it("orders the levels from none to most, which is what the strip renders", () => {
    expect(EFFORT_LEVELS).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
  });

  it("spawns settings-layer levels through --settings so a live switch hits the same layer", () => {
    expect(effortArgs("high")).toEqual(["--settings", '{"effortLevel":"high"}']);
  });

  it("spawns max through --effort, the only place it exists", () => {
    expect(effortArgs("max")).toEqual(["--effort", "max"]);
  });

  it("passes nothing for default", () => {
    expect(effortArgs("default")).toEqual([]);
  });

  it("switches between settings-layer levels live", () => {
    expect(liveEffortSetting("default", "low")).toBe("low");
    expect(liveEffortSetting("high", "xhigh")).toBe("xhigh");
  });

  it("needs a respawn to reach or leave max", () => {
    expect(liveEffortSetting("high", "max")).toBeUndefined();
    expect(liveEffortSetting("max", "low")).toBeUndefined();
  });

  it("clears back to default live only when the process was launched with none", () => {
    expect(liveEffortSetting("default", "default")).toBeNull();
    expect(liveEffortSetting("high", "default")).toBeUndefined();
  });
});
