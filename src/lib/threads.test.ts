import { describe, expect, it } from "vitest";
import {
  continueCwd,
  continuePrimer,
  memberOf,
  sortThreads,
  threadAsMarkdown,
  threadsOf,
  titleFromSession,
  withNote,
  withSession,
  withStatus,
  withTitle,
  withoutSession,
  type Thread,
} from "./threads";
import type { SessionMeta } from "./types";

const NOW = Date.parse("2026-09-29T10:00:00.000Z");

const THREAD: Thread = {
  id: "dlp",
  title: "DLP rollout",
  status: "open",
  created: "2026-09-24T10:00:00.000Z",
  updated: "2026-09-24T10:00:00.000Z",
  note: "",
  sessions: [],
  log: [],
  extra: "",
};

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "47c10375-ff4e-40b8-81f4-ec8f8cb34b1f",
    file: "/home/me/.claude/projects/-p/47c10375.jsonl",
    projectDir: "-p",
    cwd: "/home/me/playground",
    gitBranch: null,
    title: "[TBC] DLP first pass",
    lastPrompt: null,
    model: null,
    version: null,
    modifiedMs: 0,
    lastActivityMs: 0,
    sizeBytes: 0,
    status: "finished",
    messageCount: 0,
    messageCountExact: true,
    runningAgents: [],
    runningWorkflows: [],
    backgroundTasks: [],
    ...over,
  };
}

describe("titleFromSession", () => {
  it("drops the hand-typed continuation tag", () => {
    expect(titleFromSession(meta())).toBe("DLP first pass");
    expect(titleFromSession(meta({ title: "[wip]  thing" }))).toBe("thing");
  });

  it("falls back to the prompt, then the id", () => {
    expect(titleFromSession(meta({ title: null, lastPrompt: "fix it" }))).toBe("fix it");
    expect(titleFromSession(meta({ title: null }))).toBe("47c10375");
  });
});

describe("edits", () => {
  it("adds a session once and logs it", () => {
    const one = withSession(THREAD, memberOf(meta(), NOW), NOW);
    const twice = withSession(one, memberOf(meta(), NOW), NOW);
    expect(one.sessions).toHaveLength(1);
    expect(twice).toBe(one);
    expect(one.log[0]).toEqual({
      at: "2026-09-29T10:00:00.000Z",
      text: "added 47c10375 · [TBC] DLP first pass",
    });
    expect(THREAD.sessions).toHaveLength(0);
  });

  it("removes a session and logs it, ignoring strangers", () => {
    const one = withSession(THREAD, memberOf(meta(), NOW), NOW);
    expect(withoutSession(one, "nope", NOW)).toBe(one);
    const none = withoutSession(one, meta().id, NOW);
    expect(none.sessions).toHaveLength(0);
    expect(none.log.at(-1)?.text).toMatch(/^removed 47c10375/);
  });

  it("logs status changes but not no-ops", () => {
    expect(withStatus(THREAD, "open", NOW)).toBe(THREAD);
    expect(withStatus(THREAD, "done", NOW).log.at(-1)?.text).toBe("closed");
  });

  it("does not log note edits", () => {
    const next = withNote(THREAD, "refine policies");
    expect(next.note).toBe("refine policies");
    expect(next.log).toHaveLength(0);
  });

  it("ignores blank renames", () => {
    expect(withTitle(THREAD, "   ", NOW)).toBe(THREAD);
    expect(withTitle(THREAD, "DLP v2", NOW).log.at(-1)?.text).toBe("renamed from DLP rollout");
  });
});

describe("sortThreads", () => {
  it("puts closed threads last, newest update first", () => {
    const a = { ...THREAD, id: "a", updated: "2026-09-01T00:00:00.000Z" };
    const b = { ...THREAD, id: "b", updated: "2026-09-02T00:00:00.000Z" };
    const c = { ...THREAD, id: "c", status: "done" as const, updated: "2026-09-03T00:00:00.000Z" };
    expect(sortThreads([c, a, b]).map((t) => t.id)).toEqual(["b", "a", "c"]);
  });
});

describe("membership", () => {
  it("finds the threads a session is in", () => {
    const one = withSession(THREAD, memberOf(meta(), NOW), NOW);
    expect(threadsOf([one, THREAD], meta().id).map((t) => t.id)).toEqual(["dlp"]);
  });

  it("continues in the newest member's repo", () => {
    const one = withSession(THREAD, memberOf(meta(), NOW), NOW);
    const two = withSession(one, memberOf(meta({ id: "b", cwd: "/work/b" }), NOW), NOW);
    expect(continueCwd(two, "/fallback")).toBe("/work/b");
    expect(continueCwd(THREAD, "/fallback")).toBe("/fallback");
  });
});

describe("continuePrimer", () => {
  it("carries the note and points at the earlier transcripts", () => {
    const thread = withNote(withSession(THREAD, memberOf(meta(), NOW), NOW), "Refine policies.");
    const primer = continuePrimer(thread, new Map([[meta().id, meta()]]));
    expect(primer).toContain('Continuing "DLP rollout".');
    expect(primer).toContain("Refine policies.");
    expect(primer).toContain("transcript: /home/me/.claude/projects/-p/47c10375.jsonl");
  });

  it("says so when there is no note", () => {
    expect(continuePrimer(THREAD, new Map())).toContain("(no note yet)");
  });
});

describe("threadAsMarkdown", () => {
  it("leaves out local paths", () => {
    const thread = withSession(THREAD, memberOf(meta(), NOW), NOW);
    const text = threadAsMarkdown(thread);
    expect(text).toContain("# DLP rollout");
    expect(text).not.toContain("/home/me");
  });
});
