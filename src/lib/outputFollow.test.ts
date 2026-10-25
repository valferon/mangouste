import { describe, expect, it } from "vitest";
import { parseBackgroundLaunch } from "./outputFollow";

describe("parseBackgroundLaunch", () => {
  it("reads a run_in_background result", () => {
    expect(
      parseBackgroundLaunch(
        "Command running in background with ID: bl1eu9ci2. Output is being written to: /tmp/claude-1000/p/s/tasks/bl1eu9ci2.output. Use Read to check.",
      ),
    ).toEqual({ id: "bl1eu9ci2", outputPath: "/tmp/claude-1000/p/s/tasks/bl1eu9ci2.output" });
  });

  it("reads a command moved to the background after its timeout", () => {
    expect(
      parseBackgroundLaunch(
        "Command was moved to the background (ID: b2x). Output is being written to: /tmp/claude-1000/a b/s/tasks/b2x.output",
      ),
    ).toEqual({ id: "b2x", outputPath: "/tmp/claude-1000/a b/s/tasks/b2x.output" });
  });

  it("ignores output that merely quotes the words", () => {
    expect(
      parseBackgroundLaunch(
        "src/x.rs: Command running in background with ID: z. Output is being written to: /p.",
      ),
    ).toBeNull();
    expect(parseBackgroundLaunch("total 0\n")).toBeNull();
  });
});
