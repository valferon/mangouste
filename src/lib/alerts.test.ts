import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_PREFS, alertText, shouldAlert, type AlertPrefs } from "./alerts";
import type { SessionStatus, SessionTransition } from "./types";

function transition(
  to: SessionStatus,
  overrides: Partial<SessionTransition> = {},
): SessionTransition {
  return {
    sessionId: "5143ae70-0000-0000-0000-000000000000",
    file: "/home/u/.claude/projects/-home-u-repo/5143ae70.jsonl",
    cwd: "/home/u/workspace/payments-service",
    title: "Fix the retry backoff",
    from: "active",
    to,
    ...overrides,
  };
}

const away = { focused: false, activeSessionId: null };
const both = { needsYou: true, turnDone: true } satisfies AlertPrefs;

describe("shouldAlert", () => {
  it("raises the two that owe you something by default", () => {
    expect(shouldAlert(transition("awaiting"), DEFAULT_ALERT_PREFS, away)).toBe(true);
    expect(shouldAlert(transition("interrupted"), DEFAULT_ALERT_PREFS, away)).toBe(true);
  });

  it("stays quiet about a clean end by default", () => {
    // Eight sessions on a machine end turns constantly, and the rail already
    // carries it as pendingReview.
    expect(shouldAlert(transition("finished"), DEFAULT_ALERT_PREFS, away)).toBe(false);
  });

  it("raises a clean end once asked to", () => {
    expect(shouldAlert(transition("finished"), both, away)).toBe(true);
  });

  it("says nothing when the preference is off", () => {
    const off: AlertPrefs = { needsYou: false, turnDone: false };
    expect(shouldAlert(transition("awaiting"), off, away)).toBe(false);
  });

  it("does not notify about the session you are looking at", () => {
    const change = transition("awaiting");
    const watching = { focused: true, activeSessionId: change.sessionId };
    expect(shouldAlert(change, DEFAULT_ALERT_PREFS, watching)).toBe(false);
  });

  it("still notifies about a different session in the focused window", () => {
    const change = transition("awaiting");
    const elsewhere = { focused: true, activeSessionId: "another-session" };
    expect(shouldAlert(change, DEFAULT_ALERT_PREFS, elsewhere)).toBe(true);
  });

  it("notifies about the open session when the window is not focused", () => {
    // An unfocused window cannot claim you can see it — the pane may be behind
    // a browser, or on a monitor you are not at.
    const change = transition("awaiting");
    const behind = { focused: false, activeSessionId: change.sessionId };
    expect(shouldAlert(change, DEFAULT_ALERT_PREFS, behind)).toBe(true);
  });

  it("ignores statuses no preference governs", () => {
    // Rust never sends these; a newer backend might, and silence is the right
    // answer to a status this build does not understand.
    expect(shouldAlert(transition("active"), both, away)).toBe(false);
    expect(shouldAlert(transition("idle"), both, away)).toBe(false);
    expect(shouldAlert(transition("pendingReview"), both, away)).toBe(false);
  });
});

describe("alertText", () => {
  it("leads with the repo, because that is what identifies it in a toast", () => {
    expect(alertText(transition("awaiting"))).toEqual({
      title: "payments-service is waiting on you",
      body: "Fix the retry backoff",
    });
  });

  it("names what each status now wants", () => {
    expect(alertText(transition("interrupted")).title).toBe("payments-service stopped mid-turn");
    expect(alertText(transition("finished")).title).toBe("payments-service finished a turn");
  });

  it("falls back to a short id, never to the last prompt", () => {
    // A prompt-derived label rewrites itself every turn; a short id does not.
    expect(alertText(transition("awaiting", { title: null })).body).toBe("5143ae70");
  });

  it("survives a cwd with no leading path", () => {
    expect(alertText(transition("awaiting", { cwd: "repo" })).title).toBe(
      "repo is waiting on you",
    );
  });
});
