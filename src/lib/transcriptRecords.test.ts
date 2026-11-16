import { describe, expect, it } from "vitest";
import { isMetaRecord } from "./transcriptRecords";
import type { ClaudeFrame } from "./types";

const user = (content: string, extra: Record<string, unknown> = {}): ClaudeFrame => ({
  type: "user",
  message: { role: "user", content },
  ...extra,
});

describe("records the CLI wrote for the model", () => {
  it("covers the caveat ahead of a command the CLI ran itself", () => {
    const caveat = user(
      "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request.</local-command-caveat>",
      { isMeta: true },
    );
    expect(isMetaRecord(caveat)).toBe(true);
  });

  it("covers an expanded skill body and a system reminder", () => {
    expect(isMetaRecord(user("# Verification Command\n\nRun the checks.", { isMeta: true }))).toBe(true);
    expect(isMetaRecord(user("<system-reminder>\nnote\n</system-reminder>", { isMeta: true }))).toBe(true);
  });
});

describe("records that stay in the log", () => {
  it("keeps a typed turn", () => {
    expect(isMetaRecord(user("fix the flaky test"))).toBe(false);
  });

  it("keeps the echo of a ran command, which is how a model switch shows", () => {
    expect(isMetaRecord(user("<command-name>/model</command-name><command-args>fable</command-args>"))).toBe(false);
    expect(isMetaRecord(user("<local-command-stdout>Set model to `fable`</local-command-stdout>"))).toBe(false);
  });

  it("keeps an interrupt marker", () => {
    expect(isMetaRecord(user("[Request interrupted by user]"))).toBe(false);
  });

  it("goes by the flag being true, not by it being present", () => {
    expect(isMetaRecord(user("typed", { isMeta: false }))).toBe(false);
    expect(isMetaRecord(user("typed", { isMeta: "true" }))).toBe(false);
  });
});
