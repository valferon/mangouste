import { describe, expect, it } from "vitest";
import { SESSION_SORTS, sortSessions } from "./sessionOrder";
import type { SessionMeta, SessionStatus } from "./types";

const NOW = Date.parse("2026-09-14T12:00:00Z");

function session(
  id: string,
  title: string | null,
  status: SessionStatus,
  lastActivityMs = NOW,
): SessionMeta {
  return {
    id,
    file: `/p/${id}.jsonl`,
    projectDir: "/p",
    cwd: "/repo",
    gitBranch: null,
    title,
    lastPrompt: null,
    model: null,
    version: null,
    modifiedMs: lastActivityMs,
    lastActivityMs,
    sizeBytes: 0,
    status,
    messageCount: 1,
    messageCountExact: true,
    runningAgents: [],
    runningWorkflows: [],
    backgroundTasks: [],
  };
}

/** The pane's overlay, which is what the rows actually draw. */
const asScanned = (s: SessionMeta) => s.status;

const titles = (sessions: readonly SessionMeta[]) => sessions.map((s) => s.title ?? s.id);

describe("sortSessions", () => {
  it("orders by status before name", () => {
    const sorted = sortSessions(
      [
        session("1", "Alpha", "idle"),
        session("2", "Zulu", "active"),
        session("3", "Bravo", "awaiting"),
      ],
      asScanned,
    );
    expect(titles(sorted)).toEqual(["Zulu", "Bravo", "Alpha"]);
  });

  it("orders same-status rows alphabetically, ignoring case", () => {
    const sorted = sortSessions(
      [
        session("1", "chainguard base image evaluation", "active"),
        session("2", "Iceberg catalog Pod Identity and access", "active"),
        session("3", "Alerting rules", "active"),
      ],
      asScanned,
    );
    expect(titles(sorted)).toEqual([
      "Alerting rules",
      "chainguard base image evaluation",
      "Iceberg catalog Pod Identity and access",
    ]);
  });

  it("does not move rows when only the activity watermark changes", () => {
    const before = sortSessions(
      [session("a1", "Alpha", "active", NOW - 5000), session("b2", "Bravo", "active", NOW)],
      asScanned,
    );
    const after = sortSessions(
      [session("a1", "Alpha", "active", NOW), session("b2", "Bravo", "active", NOW - 5000)],
      asScanned,
    );
    expect(titles(before)).toEqual(titles(after));
  });

  it("sorts an untitled session by the id stub the row prints", () => {
    const sorted = sortSessions(
      [session("zz-9", null, "finished"), session("aa-1", null, "finished")],
      asScanned,
    );
    expect(titles(sorted)).toEqual(["aa-1", "zz-9"]);
  });

  it("uses the effective status, so a pending review outranks a finished row", () => {
    const reviewed = session("1", "Alpha", "finished");
    const unread = session("2", "Bravo", "finished");
    const sorted = sortSessions([reviewed, unread], (s) =>
      s.id === "2" ? "pendingReview" : s.status,
    );
    expect(titles(sorted)).toEqual(["Bravo", "Alpha"]);
  });

  it("breaks a name tie on the id, so the scan's walk order cannot leak through", () => {
    const sorted = sortSessions(
      [session("b", "Same", "finished"), session("a", "Same", "finished")],
      asScanned,
    );
    expect(sorted.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("orders by the watermark when asked for recent, whatever the status says", () => {
    const sorted = sortSessions(
      [
        session("1", "Alpha", "active", NOW - 3 * 60_000),
        session("2", "Zulu", "idle", NOW),
        session("3", "Mike", "finished", NOW - 60_000),
      ],
      asScanned,
      "recent",
    );
    expect(titles(sorted)).toEqual(["Zulu", "Mike", "Alpha"]);
  });

  it("breaks a watermark tie on the id in recent order too", () => {
    const sorted = sortSessions(
      [session("b", "Same", "finished", NOW), session("a", "Same", "finished", NOW)],
      asScanned,
      "recent",
    );
    expect(sorted.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("defaults to status order, which is the one that holds still", () => {
    const input = [session("1", "Alpha", "idle", NOW), session("2", "Zulu", "active", NOW - 1)];
    expect(titles(sortSessions(input, asScanned))).toEqual(
      titles(sortSessions(input, asScanned, "status")),
    );
    expect(SESSION_SORTS).toEqual(["status", "recent"]);
  });

  it("leaves the input array alone", () => {
    const input = [session("1", "Zulu", "idle"), session("2", "Alpha", "active")];
    sortSessions(input, asScanned);
    expect(titles(input)).toEqual(["Zulu", "Alpha"]);
  });
});
