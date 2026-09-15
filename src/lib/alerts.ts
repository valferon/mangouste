/**
 * Whether a session's status change is worth a desktop notification, and what
 * it should say.
 *
 * Rust decides what *happened* — it owns the edge, because the session cache is
 * where the previous status already lives and reading it there is what keeps
 * two windows from announcing one event twice. This file decides whether you
 * want to hear about it, because that depends on two things only the frontend
 * knows: the preferences, and whether the session is already on screen in front
 * of you.
 *
 * Pure over its inputs so the policy can be tested without a window, a
 * notification daemon, or a session that actually changed.
 */

import { baseName } from "./paths";
import type { SessionStatus, SessionTransition } from "./types";

/**
 * The two appetites, kept apart because they really are different.
 *
 * `needsYou` is the one the rail exists for: a session blocked on a question,
 * or one that stopped mid-turn. On by default — an unanswered session is the
 * whole reason to run this app.
 *
 * `turnDone` is every clean end. Off by default: on a machine running eight
 * sessions this fires constantly, and the rail already carries it as
 * `pendingReview` without interrupting anything.
 */
export interface AlertPrefs {
  needsYou: boolean;
  turnDone: boolean;
}

export const DEFAULT_ALERT_PREFS: AlertPrefs = { needsYou: true, turnDone: false };

/** What the workbench is currently showing, which is what suppression needs. */
export interface AlertView {
  /** Whether this window has the desktop's focus. */
  focused: boolean;
  /** The session attached to the chat pane, if any. */
  activeSessionId: string | null;
}

/** Which preference governs a transition into `to`, if any does. */
function enabled(to: SessionStatus, prefs: AlertPrefs): boolean {
  if (to === "awaiting" || to === "interrupted") return prefs.needsYou;
  if (to === "finished") return prefs.turnDone;
  // Rust only ever announces those three — `pendingReview` is an overlay that
  // exists solely on this side, and the rest are not notable. Anything else
  // arriving here is a newer backend talking to an older frontend, and the
  // right answer to a status this build does not understand is silence.
  return false;
}

/**
 * Whether to raise a notification for this transition.
 *
 * The suppression is narrow on purpose: *this* window focused, showing *that*
 * session. Notifying about the pane you are looking at is noise, but an
 * unfocused window has no idea whether you can see it — a window can be
 * unfocused and fully visible on a second monitor — and the failure that
 * matters is the missed `awaiting`, not the redundant toast.
 */
export function shouldAlert(
  transition: SessionTransition,
  prefs: AlertPrefs,
  view: AlertView,
): boolean {
  if (!enabled(transition.to, prefs)) return false;
  if (view.focused && view.activeSessionId === transition.sessionId) return false;
  return true;
}

/** Headline per status: what the session now wants, not what it did. */
const HEADLINE: Partial<Record<SessionStatus, string>> = {
  awaiting: "is waiting on you",
  interrupted: "stopped mid-turn",
  finished: "finished a turn",
};

/**
 * Notification copy for a transition.
 *
 * The repo leads, because on a machine with sessions in six repos "which repo"
 * is the first thing you need and the only thing that fits in a toast's first
 * line. The session's own title is the body — an untitled session falls back to
 * a short id rather than to its last prompt, which churns on every turn.
 */
export function alertText(transition: SessionTransition): { title: string; body: string } {
  const repo = baseName(transition.cwd) || transition.cwd;
  const headline = HEADLINE[transition.to] ?? "changed";
  return {
    title: `${repo} ${headline}`,
    body: transition.title ?? transition.sessionId.slice(0, 8),
  };
}
