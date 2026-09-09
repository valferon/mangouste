import { describe, expect, it } from "vitest";
import { RETIRE_AFTER_MS, retirableTabs, sessionsById, type RetireSnapshot } from "./tabRetire";
import type { ProjectGroup, SessionMeta, SessionStatus } from "./types";
import type { Tab } from "./tabs";

const NOW = Date.parse("2026-09-09T12:00:00Z");
const HOUR = 60 * 60 * 1000;

/** Neither flag set, which is the state of almost every session. */
const none = () => false;
/** The overlay predicate for exactly one flagged session. */
const only =
  (flagged: string) =>
  (id: string): boolean =>
    id === flagged;

function session(id: string, agoMs: number, status: SessionStatus = "idle"): SessionMeta {
  return {
    id,
    file: `/p/${id}.jsonl`,
    projectDir: "/p",
    cwd: "/repo",
    gitBranch: null,
    title: id,
    lastPrompt: null,
    model: null,
    version: null,
    modifiedMs: NOW - agoMs,
    lastActivityMs: NOW - agoMs,
    sizeBytes: 0,
    status,
    messageCount: 1,
    messageCountExact: true,
    runningAgents: [],
    runningWorkflows: [],
  };
}

function chat(id: string, sessionId: string | null): Tab {
  return { kind: "chat", id, cwd: "/repo", sessionId, resumeFile: null, surface: "chat" };
}

function groupOf(...sessions: SessionMeta[]): ProjectGroup[] {
  return [{ dirName: "p", cwd: "/repo", label: "repo", sessions }];
}

/** One tab holding one session, which is all most of these cases need. */
function one(overrides: Partial<RetireSnapshot> = {}): RetireSnapshot {
  return {
    tabs: [chat("t", "s")],
    sessions: sessionsById(groupOf(session("s", 72 * HOUR))),
    activeTab: "",
    isPinned: none,
    isArchived: none,
    now: NOW,
    ...overrides,
  };
}

/** The common case: one stale tab, one fresh, and a stale one in front. */
function snapshot(overrides: Partial<RetireSnapshot> = {}): RetireSnapshot {
  return {
    tabs: [chat("t-old", "s-old"), chat("t-new", "s-new"), chat("t-front", "s-front")],
    sessions: sessionsById(
      groupOf(
        session("s-old", 72 * HOUR),
        session("s-new", 2 * HOUR),
        session("s-front", 72 * HOUR),
      ),
    ),
    activeTab: "t-front",
    isPinned: none,
    isArchived: none,
    now: NOW,
    ...overrides,
  };
}

describe("retirableTabs", () => {
  it("retires a tab whose session has been quiet past the cutoff", () => {
    expect(retirableTabs(snapshot())).toEqual(["t-old"]);
  });

  it("leaves a session that was active within the cutoff", () => {
    expect(retirableTabs(snapshot({ now: NOW - 48 * HOUR }))).toEqual([]);
  });

  it("treats the cutoff as exclusive, so a tab exactly at it survives", () => {
    const sessions = sessionsById(groupOf(session("s", RETIRE_AFTER_MS)));
    expect(retirableTabs(one({ sessions }))).toEqual([]);
  });

  it("never retires the tab in front, however old it is", () => {
    // `s-front` is as stale as `s-old`; only the one nobody is looking at goes.
    expect(retirableTabs(snapshot())).not.toContain("t-front");
  });

  it("never retires a pinned session", () => {
    expect(retirableTabs(snapshot({ isPinned: only("s-old") }))).toEqual([]);
  });

  it.each<SessionStatus>(["active", "awaiting", "pendingReview"])(
    "keeps a %s session even when its watermark is old",
    (status) => {
      const sessions = sessionsById(groupOf(session("s", 72 * HOUR, status)));
      expect(retirableTabs(one({ sessions }))).toEqual([]);
    },
  );

  it.each<SessionStatus>(["idle", "finished", "interrupted"])(
    "retires a %s session past the cutoff",
    (status) => {
      const sessions = sessionsById(groupOf(session("s", 72 * HOUR, status)));
      expect(retirableTabs(one({ sessions }))).toEqual(["t"]);
    },
  );

  it("leaves an unstarted 'New session' tab alone", () => {
    expect(retirableTabs(one({ tabs: [chat("t", null)] }))).toEqual([]);
  });

  it("leaves a tab whose session the scan did not find", () => {
    // The whole strip before the first scan lands: absence must not read as old.
    expect(retirableTabs(snapshot({ sessions: new Map() }))).toEqual([]);
  });

  it("ignores tabs that are not chats", () => {
    const tabs: Tab[] = [
      { kind: "file", id: "file:/repo/a.ts", cwd: "/repo", path: "/repo/a.ts", label: "a.ts" },
      { kind: "history", id: "history:/repo", cwd: "/repo", label: "History" },
      { kind: "dashboard", id: "dashboard", label: "Dashboard" },
    ];
    expect(retirableTabs(one({ tabs, sessions: new Map() }))).toEqual([]);
  });

  it("orders the result oldest watermark first", () => {
    const tabs = [chat("t-a", "s-a"), chat("t-b", "s-b"), chat("t-c", "s-c")];
    const sessions = sessionsById(
      groupOf(session("s-a", 60 * HOUR), session("s-b", 200 * HOUR), session("s-c", 90 * HOUR)),
    );
    expect(retirableTabs(one({ tabs, sessions }))).toEqual(["t-b", "t-c", "t-a"]);
  });

  describe("archived", () => {
    it("retires an archived session without waiting for the cutoff", () => {
      const sessions = sessionsById(groupOf(session("s", 1 * HOUR)));
      expect(retirableTabs(one({ sessions, isArchived: only("s") }))).toEqual(["t"]);
    });

    it("still leaves the tab in front alone", () => {
      const sessions = sessionsById(groupOf(session("s", 1 * HOUR)));
      expect(retirableTabs(one({ sessions, activeTab: "t", isArchived: only("s") }))).toEqual([]);
    });

    it("lets a pin outrank the archive, as the sessions pane does", () => {
      const sessions = sessionsById(groupOf(session("s", 1 * HOUR)));
      expect(
        retirableTabs(one({ sessions, isArchived: only("s"), isPinned: only("s") })),
      ).toEqual([]);
    });

    it.each<SessionStatus>(["active", "awaiting", "pendingReview"])(
      "waits for a %s turn to settle before retiring an archived session",
      (status) => {
        const sessions = sessionsById(groupOf(session("s", 1 * HOUR, status)));
        expect(retirableTabs(one({ sessions, isArchived: only("s") }))).toEqual([]);
      },
    );
  });
});

describe("sessionsById", () => {
  it("flattens every group into one lookup", () => {
    const groups: ProjectGroup[] = [
      { dirName: "a", cwd: "/a", label: "a", sessions: [session("s1", 0)] },
      { dirName: "b", cwd: "/b", label: "b", sessions: [session("s2", 0), session("s3", 0)] },
    ];
    expect([...sessionsById(groups).keys()]).toEqual(["s1", "s2", "s3"]);
  });
});
