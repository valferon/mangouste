import { describe, expect, it } from "vitest";
import { recapFileLabel, recapHeadline } from "./recap";
import type { SessionRecap } from "./types";

const EMPTY: SessionRecap = {
  file: "/home/me/.claude/projects/-repo/abc.jsonl",
  firstPrompt: null,
  lastPrompt: null,
  prompts: 0,
  files: [],
  fileCount: 0,
  commits: [],
  commitCount: 0,
  branches: [],
  tools: [],
  toolCalls: 0,
  agents: [],
  agentCount: 0,
  bytesRead: 0,
  scanMs: 0,
  truncated: false,
};

describe("recapHeadline", () => {
  it("leads with the strongest evidence the session did something", () => {
    expect(
      recapHeadline({ ...EMPTY, commitCount: 2, fileCount: 9, agentCount: 3, prompts: 41 }),
    ).toBe("2 commits · 9 files · 3 agents · 41 asks");
  });

  it("leaves out what did not happen rather than showing a zero", () => {
    expect(recapHeadline({ ...EMPTY, fileCount: 1, prompts: 4 })).toBe("1 file · 4 asks");
  });

  it("has a sentence for a session that only talked", () => {
    expect(recapHeadline(EMPTY)).toBe("nothing but conversation");
  });
});

describe("recapFileLabel", () => {
  it("writes a path from inside the session's own repo", () => {
    expect(recapFileLabel("/home/me/repo/src/rail.tsx", "/home/me/repo")).toBe("src/rail.tsx");
  });

  it("elides a path that reached outside it", () => {
    expect(recapFileLabel("/home/me/.config/nvim/init.lua", "/home/me/repo")).toBe(
      "…/nvim/init.lua",
    );
  });

  it("leaves a short path alone", () => {
    expect(recapFileLabel("/etc/hosts", "/home/me/repo")).toBe("/etc/hosts");
    expect(recapFileLabel("notes.md", null)).toBe("notes.md");
  });

  it("does not treat a sibling repo as a prefix", () => {
    // `/home/me/repo` must not swallow `/home/me/repo-two`, which is a different
    // checkout and reads as `two/src/…` if the boundary is not checked.
    expect(recapFileLabel("/home/me/repo-two/src/a.ts", "/home/me/repo")).toBe("…/src/a.ts");
  });
});
