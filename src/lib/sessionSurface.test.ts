import { describe, expect, it } from "vitest";

import { claudeLaunch, claudeResume, claudeStart, mintSessionId } from "./sessionSurface";

const ID = "47307543-1524-43eb-9d5d-6fba3e9ffbc2";

/** Anything that is not an id, and would be something else in a shell. */
const HOSTILE = [
  "abc; rm -rf ~",
  "$(id)",
  "`id`",
  "a b",
  "--dangerously-skip-permissions",
  "-r",
  "",
  "..",
  "/etc/passwd",
];

describe("claudeStart", () => {
  it("names the session, so the tab and the transcript are the same one", () => {
    expect(claudeStart(ID)).toBe(`claude --session-id ${ID}`);
  });

  it("will not type anything but an id into the shell", () => {
    for (const hostile of HOSTILE) expect(claudeStart(hostile)).toBe("claude");
  });
});

describe("claudeResume", () => {
  it("resumes the session it is given", () => {
    expect(claudeResume(ID)).toBe(`claude --resume ${ID}`);
  });

  it("starts a session rather than passing a non-id along", () => {
    for (const hostile of HOSTILE) expect(claudeResume(hostile)).toBe("claude");
  });
});

describe("claudeLaunch", () => {
  it("resumes a session that has a transcript", () => {
    expect(claudeLaunch(ID, "/home/u/.claude/projects/p/47307543.jsonl")).toBe(
      `claude --resume ${ID}`,
    );
  });

  it("starts one that does not", () => {
    // `--resume` against a session claude never wrote is an error message where
    // a conversation should be.
    expect(claudeLaunch(ID, null)).toBe(`claude --session-id ${ID}`);
  });
});

describe("mintSessionId", () => {
  it("is shaped like the ids the CLI writes", () => {
    // Same shape because the transcript filenames are these, and because the id
    // is about to be typed into a shell — see the guard the launchers apply.
    const id = mintSessionId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(claudeStart(id)).toBe(`claude --session-id ${id}`);
  });

  it("does not repeat itself", () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintSessionId()));
    expect(ids.size).toBe(200);
  });
});
