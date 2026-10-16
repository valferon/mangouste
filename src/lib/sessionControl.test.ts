import { describe, expect, it } from "vitest";
import { cleanPrompts, dueOneOffs, normaliseDraft, type QuickPrompt } from "./quickPrompts";
import {
  MAX_TIMED,
  controlSpawnMode,
  describeScheduled,
  findSession,
  planCancel,
  planFork,
  planNewSession,
  planSchedule,
  whenCaption,
  type ControlCaller,
} from "./sessionControl";
import type { ProjectGroup, SessionMeta } from "./types";

const NOW = new Date("2026-10-14T10:00:00Z");

const inChat: ControlCaller = { inChat: true, sessionId: "s-1", cwd: "/repo" };
const outside: ControlCaller = { inChat: false, sessionId: null, cwd: null };

const prompt = (id: string, overrides: Partial<QuickPrompt> = {}): QuickPrompt => ({
  id,
  label: id,
  text: `text ${id}`,
  submit: true,
  newSession: true,
  project: "/repo",
  schedule: null,
  at: null,
  session: null,
  origin: null,
  ...overrides,
});

describe("planSchedule", () => {
  it("defaults to a follow-up in the calling session", () => {
    const planned = planSchedule({ text: "check CI", in_minutes: 30 }, inChat, [], NOW, "p1");
    expect(planned).toEqual({
      ok: true,
      value: {
        id: "p1",
        label: "check CI",
        text: "check CI",
        submit: true,
        newSession: true,
        project: "/repo",
        schedule: null,
        at: "2026-10-14T10:30:00.000Z",
        session: "s-1",
        origin: "s-1",
      },
    });
  });

  it("takes an ISO time with an offset", () => {
    const planned = planSchedule({ text: "x", at: "2026-10-15T09:00:00+02:00" }, inChat, [], NOW, "p");
    expect(planned.ok && planned.value.at).toBe("2026-10-15T07:00:00.000Z");
  });

  it("schedules a recurring new session in the caller's repo", () => {
    const planned = planSchedule(
      { text: "triage", cron: "0 9 * * 1-5", target: "new_session" },
      inChat,
      [],
      NOW,
      "p",
    );
    expect(planned.ok && planned.value).toMatchObject({
      schedule: "0 9 * * 1-5",
      at: null,
      session: null,
      project: "/repo",
    });
  });

  it("wants exactly one time", () => {
    expect(planSchedule({ text: "x" }, inChat, [], NOW, "p").ok).toBe(false);
    expect(planSchedule({ text: "x", in_minutes: 5, cron: "* * * * *" }, inChat, [], NOW, "p").ok).toBe(false);
  });

  it("refuses bad times", () => {
    const bad = [
      { in_minutes: 0 },
      { in_minutes: "5" },
      { at: "tomorrow" },
      { at: "2026-10-14T09:00:00Z" },
      { at: "2028-01-01T00:00:00Z" },
      { cron: "every day" },
    ];
    for (const when of bad) {
      expect(planSchedule({ text: "x", ...when }, inChat, [], NOW, "p").ok).toBe(false);
    }
  });

  it("holds a chat to its own session", () => {
    const planned = planSchedule({ text: "x", in_minutes: 5, session_id: "other" }, inChat, [], NOW, "p");
    expect(planned).toEqual({ ok: false, error: expect.stringContaining("only act on itself") });
    // Naming itself is fine.
    expect(planSchedule({ text: "x", in_minutes: 5, session_id: "s-1" }, inChat, [], NOW, "p").ok).toBe(true);
  });

  it("refuses a chat whose session is not known yet, rather than guess", () => {
    const fresh: ControlCaller = { inChat: true, sessionId: null, cwd: "/repo" };
    expect(planSchedule({ text: "x", in_minutes: 5 }, fresh, [], NOW, "p")).toEqual({
      ok: false,
      error: expect.stringContaining("not started yet"),
    });
    expect(planSchedule({ text: "x", in_minutes: 5, session_id: "other" }, fresh, [], NOW, "p").ok).toBe(false);
  });

  it("holds a chat to its own repo", () => {
    const at = { text: "x", in_minutes: 5, target: "new_session" };
    expect(planSchedule({ ...at, project: "/repo/sub" }, inChat, [], NOW, "p").ok).toBe(true);
    expect(planSchedule({ ...at, project: "/elsewhere" }, inChat, [], NOW, "p")).toEqual({
      ok: false,
      error: expect.stringContaining("its own repo"),
    });
    expect(planSchedule({ ...at, project: "/repo/../elsewhere" }, inChat, [], NOW, "p").ok).toBe(false);
    expect(planSchedule({ ...at, project: "/repository" }, inChat, [], NOW, "p").ok).toBe(false);
  });

  it("lets an outside caller name a session, but needs somewhere to start a new one", () => {
    expect(planSchedule({ text: "x", in_minutes: 5, session_id: "any" }, outside, [], NOW, "p").ok).toBe(true);
    expect(planSchedule({ text: "x", in_minutes: 5 }, outside, [], NOW, "p")).toEqual({
      ok: false,
      error: expect.stringContaining("`project`"),
    });
    expect(planSchedule({ text: "x", in_minutes: 5, project: "relative" }, outside, [], NOW, "p").ok).toBe(false);
  });

  it("stops at the ceiling", () => {
    const full = Array.from({ length: MAX_TIMED }, (_, i) => prompt(`t${i}`, { schedule: "@daily" }));
    expect(planSchedule({ text: "x", in_minutes: 5 }, inChat, full, NOW, "p").ok).toBe(false);
  });

  it("reads garbage arguments as missing ones", () => {
    expect(planSchedule(null, inChat, [], NOW, "p").ok).toBe(false);
    expect(planSchedule(["text"], inChat, [], NOW, "p").ok).toBe(false);
    expect(planSchedule({ text: 42, in_minutes: 5 }, inChat, [], NOW, "p").ok).toBe(false);
  });
});

describe("planCancel", () => {
  const list = [
    prompt("mine", { at: NOW.toISOString(), origin: "s-1" }),
    prompt("theirs", { at: NOW.toISOString(), origin: "s-2" }),
    prompt("hand-made cron", { schedule: "@daily" }),
    prompt("button", { newSession: false }),
  ];

  it("removes the caller's own timed prompt", () => {
    expect(planCancel({ id: "mine" }, list, inChat)).toEqual({ ok: true, value: "mine" });
  });

  it("leaves other sessions' prompts and anything made by hand alone", () => {
    for (const id of ["theirs", "hand-made cron", "button", "missing"]) {
      expect(planCancel({ id }, list, inChat).ok).toBe(false);
    }
    expect(planCancel({}, list, inChat).ok).toBe(false);
  });

  it("lets an outside caller cancel any session-made prompt, still not hand-made ones", () => {
    expect(planCancel({ id: "theirs" }, list, outside).ok).toBe(true);
    expect(planCancel({ id: "hand-made cron" }, list, outside).ok).toBe(false);
  });
});

describe("planNewSession and planFork", () => {
  it("opens in the caller's repo unless told otherwise", () => {
    expect(planNewSession({ text: "go" }, inChat)).toEqual({
      ok: true,
      value: { text: "go", project: "/repo", focus: false },
    });
    expect(planNewSession({ text: "go", project: "/repo/web", focus: true }, inChat)).toEqual({
      ok: true,
      value: { text: "go", project: "/repo/web", focus: true },
    });
    expect(planNewSession({ text: "go", project: "/other" }, inChat).ok).toBe(false);
    expect(planNewSession({ text: "go" }, outside).ok).toBe(false);
    expect(planNewSession({ text: "go", project: "/other/" }, outside)).toEqual({
      ok: true,
      value: { text: "go", project: "/other", focus: false },
    });
  });

  it("forks the caller, and only the caller", () => {
    expect(planFork({}, inChat)).toEqual({ ok: true, value: { session: "s-1", text: null, focus: false } });
    expect(planFork({ session_id: "other" }, inChat).ok).toBe(false);
    expect(planFork({}, outside).ok).toBe(false);
    expect(planFork({ session_id: "any", text: "try B" }, outside)).toEqual({
      ok: true,
      value: { session: "any", text: "try B", focus: false },
    });
  });
});

describe("one-off prompts", () => {
  it("are due once their time has passed, oldest first", () => {
    const list = [
      prompt("later", { at: "2026-10-14T11:00:00Z" }),
      prompt("late", { at: "2026-10-14T09:59:00Z" }),
      prompt("earliest", { at: "2026-10-13T08:00:00Z" }),
      prompt("cron", { schedule: "* * * * *" }),
    ];
    expect(dueOneOffs(list, NOW).map((p) => p.id)).toEqual(["earliest", "late"]);
  });

  it("survive a round trip through the store, and lose a bad time", () => {
    const stored = [prompt("a", { at: "2026-10-14T11:00:00.000Z", session: "s-1" }), prompt("b", { at: "soon" })];
    expect(cleanPrompts(stored)).toEqual([stored[0], prompt("b")]);
  });

  it("let a cron schedule replace the one-off time", () => {
    const draft = { ...prompt("a", { at: "2026-10-14T11:00:00Z", session: "s-1" }), schedule: "@daily" };
    expect(normaliseDraft(draft)).toMatchObject({ schedule: "@daily", at: null, session: "s-1" });
  });

  it("drop the session target once nothing times the prompt", () => {
    expect(normaliseDraft({ ...prompt("a", { session: "s-1" }) })?.session).toBeNull();
  });
});

describe("describing and captions", () => {
  it("lists the caller's timed prompts with their next run", () => {
    const list = [
      prompt("once", { at: "2026-10-14T11:00:00.000Z", session: "s-1", origin: "s-1" }),
      prompt("daily", { schedule: "0 9 * * *", origin: "s-1" }),
      prompt("theirs", { schedule: "0 9 * * *", origin: "s-2" }),
      prompt("hand-made", { schedule: "0 9 * * *" }),
      prompt("button", { newSession: false }),
    ];
    const described = describeScheduled(list, NOW, inChat);
    expect(described.map((entry) => [entry.id, entry.schedule, entry.session])).toEqual([
      ["once", "once", "s-1"],
      ["daily", "0 9 * * *", null],
    ]);
    expect(described[0].nextRun).toBe("2026-10-14T11:00:00.000Z");
    expect(described[1].nextRun).not.toBeNull();
  });

  it("says when", () => {
    expect(whenCaption({ schedule: null, at: "2026-10-14T09:00:00Z" }, NOW)).toBe("due now");
    expect(whenCaption({ schedule: null, at: "2026-10-14T11:00:00Z" }, NOW)).toMatch(/^once /);
    expect(whenCaption({ schedule: null, at: null }, NOW)).toBeNull();
  });
});

describe("findSession", () => {
  it("finds the repo and transcript for a session id", () => {
    const groups = [
      { dirName: "d", cwd: "/repo", label: "repo", sessions: [{ id: "s-1", file: "/t/s-1.jsonl" } as SessionMeta] },
    ] as ProjectGroup[];
    expect(findSession(groups, "s-1")).toEqual({ cwd: "/repo", file: "/t/s-1.jsonl" });
    expect(findSession(groups, "nope")).toBeNull();
  });
});

describe("controlSpawnMode", () => {
  it("never hands a session-started session a mode looser than default", () => {
    expect(controlSpawnMode("bypassPermissions")).toBe("default");
    expect(controlSpawnMode("acceptEdits")).toBe("default");
    expect(controlSpawnMode("default")).toBe("default");
  });

  it("keeps plan, which is stricter still", () => {
    expect(controlSpawnMode("plan")).toBe("plan");
  });
});
