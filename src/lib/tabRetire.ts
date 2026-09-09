/**
 * Which open chat tabs have gone quiet long enough — or been archived — to
 * close themselves.
 *
 * A tab strip is not a filing cabinet. Sessions accumulate — a repo touched
 * once, a question asked and answered, a branch that shipped — and nothing ever
 * takes them back out, so a window left up for a day arrives at fifty chat tabs
 * across twenty repos. That is not only clutter: `App.tsx` keeps every repo's
 * panes mounted on purpose (unmounting one loses its transcript), and every
 * mounted pane is a listener on every streamed frame, so the strip is also the
 * app's standing cost. Retiring the tabs you have stopped using is the only
 * thing that bounds it.
 *
 * The clock is `lastActivityMs`, the conversational watermark, and deliberately
 * not the transcript's mtime: opening a session rewrites its log, and title
 * regeneration and history snapshots bump mtime too. Ageing on mtime would keep
 * a tab alive because you glanced at it last Tuesday, which is exactly the tab
 * this is meant to retire.
 *
 * Everything here is a pure decision over a snapshot. The closing lives in
 * `App.tsx`, because closing a chat tab means killing the process behind it and
 * that is not a decision a helper should be making on its own.
 */

import type { ProjectGroup, SessionMeta, SessionStatus } from "./types";
import type { Tab } from "./tabs";

/**
 * How long a session may sit untouched before its tab retires itself.
 *
 * Two days rather than one: a session picked up the next morning is still the
 * one you were working on, and a tab that vanishes overnight is a tab you have
 * to go find in the sidebar. Two days is long enough to survive a weekend
 * Friday-to-Monday only by accident, which is the right accident — by Monday
 * the Friday session really is history.
 */
export const RETIRE_AFTER_MS = 48 * 60 * 60 * 1000;

/**
 * Statuses that outrank the clock, however old the watermark is.
 *
 * `active` and `awaiting` are self-evident — a turn is running, or the CLI is
 * blocked on a permission answer, and killing either loses work in flight.
 * `pendingReview` is the one worth spelling out: it means "this finished while
 * you were looking elsewhere and you have not read it yet". Retiring it would
 * throw away the exact thing it is holding the tab open to show you.
 */
const KEEP_STATUS: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  "active",
  "awaiting",
  "pendingReview",
]);

/** The scan's sessions keyed by id, which is how a tab names the one it holds. */
export function sessionsById(groups: readonly ProjectGroup[]): Map<string, SessionMeta> {
  const byId = new Map<string, SessionMeta>();
  for (const group of groups) {
    for (const session of group.sessions) byId.set(session.id, session);
  }
  return byId;
}

export interface RetireSnapshot {
  tabs: readonly Tab[];
  /**
   * The sessions the last scan found, by id.
   *
   * A tab whose session is missing here is left alone. Absence is not evidence
   * of staleness: the scan skips some project dirs, a transcript can be moved,
   * and this map is empty entirely until the first scan lands. Reading absence
   * as "old" would close the whole strip on the frame before the scan arrives.
   */
  sessions: ReadonlyMap<string, SessionMeta>;
  /** Never retired, whatever its watermark says — you are looking at it. */
  activeTab: string;
  /** The overlay's pin test: a pin is a standing "keep this". */
  isPinned: (id: string) => boolean;
  /**
   * The overlay's archive test, which retires a tab without waiting for the
   * clock.
   *
   * Archiving is the one thing the sessions pane does that already means "I am
   * done with this", so a tab left open behind it is the two views disagreeing
   * about the same session. The pane's other ways of hiding a row are not this:
   * the filter box, `onlyLive` and `showIdle` are unpersisted view state that
   * resets every launch, and closing tabs from them would turn typing in a
   * search box into killing thirty processes.
   */
  isArchived: (id: string) => boolean;
  now: number;
  /** Overridable so the tests do not have to sleep for two days. */
  afterMs?: number;
}

/**
 * The ids to close, oldest watermark first.
 *
 * Ordered rather than arbitrary so that a caller which decides to stop early —
 * a cap on how many tabs may vanish at once, say — drops the least useful ones.
 */
export function retirableTabs(snapshot: RetireSnapshot): string[] {
  const { tabs, sessions, activeTab, isPinned, isArchived, now } = snapshot;
  const afterMs = snapshot.afterMs ?? RETIRE_AFTER_MS;
  const stale: { id: string; at: number }[] = [];

  for (const tab of tabs) {
    // Only chats age. A file tab is a buffer that may be dirty, a history tab
    // is a view with no session behind it, and the dashboard belongs to no repo
    // at all — none of them have a conversational watermark to age against.
    if (tab.kind !== "chat") continue;
    if (tab.id === activeTab) continue;
    // A tab with no session id is a "New session" the repo seed just minted.
    // It has no history to lose and closing it would only make the seed mint
    // another one on the next repo switch.
    if (tab.sessionId === null) continue;
    if (isPinned(tab.sessionId)) continue;

    const session = sessions.get(tab.sessionId);
    if (session === undefined) continue;
    // Ahead of the archive check, not behind it: archiving a session that is
    // mid-turn is a statement about what happens next, not a licence to kill
    // the turn running now. The tab goes on the first sweep after it settles.
    if (KEEP_STATUS.has(session.status)) continue;
    // Archived skips the clock. The pin check above still wins, matching the
    // pane, which tests `isPinned` before `isArchived` for the same reason.
    if (!isArchived(tab.sessionId) && now - session.lastActivityMs <= afterMs) continue;

    stale.push({ id: tab.id, at: session.lastActivityMs });
  }

  return stale.sort((a, b) => a.at - b.at).map((entry) => entry.id);
}
