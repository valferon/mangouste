/**
 * The order sessions sit in inside a repo group on the rail.
 *
 * The scan hands them over newest-watermark-first, which is the right answer for
 * "what happened last" and the wrong one for a list you read with your eyes. Two
 * sessions working at once both rewrite their watermark every few seconds, so
 * recency order makes the rows trade places while you are aiming at one — the
 * click lands on the neighbour. A list that moves under the cursor is worse at
 * its job than a list that is slightly stale.
 *
 * So: status first, name second. Status is the only thing about a row that is
 * worth reordering the list for, because it is the answer to "does this want
 * me"; within a status nothing changes unless a session is renamed, which is
 * rare and deliberate. The recency the scan computed is still on every row as
 * its age stamp, so nothing is lost — it just stops being the thing that moves
 * rows around.
 */

import type { SessionMeta, SessionStatus } from "./types";

/**
 * The two orders the rail offers.
 *
 * `status` is the default: rows hold still, and the only thing that moves one
 * is a change worth moving it for. `recent` is the scan's own order — newest
 * watermark first — which is the right answer to a different question: "which
 * one was I in a minute ago", asked most often with a filter typed above it.
 * A toggle rather than a mode per view, because the answer to that question is
 * the same whether or not a filter is narrowing the list.
 */
export type SessionSort = "status" | "recent";

/** Every order, for the stored-value guard. */
export const SESSION_SORTS: readonly SessionSort[] = ["status", "recent"];

/**
 * Statuses from most to least worth your attention.
 *
 * The first three are the group header's own summary order (live, asking,
 * review), so the header and the rows it summarises agree about what leads.
 * `interrupted` follows: a cut-off turn is a fact you have to act on, unlike
 * `finished`, which is one you have already read. `idle` is last — it is hidden
 * by default, and when shown it is history.
 */
const STATUS_ORDER: readonly SessionStatus[] = [
  "active",
  "awaiting",
  "pendingReview",
  "interrupted",
  "finished",
  "idle",
];

const RANK = new Map<SessionStatus, number>(STATUS_ORDER.map((status, i) => [status, i]));

/**
 * What the row prints, which is what "alphabetical" has to mean.
 *
 * A session with no title renders the head of its id, so sorting on the raw
 * title would order untitled rows by text nobody can see.
 */
function sortLabel(session: SessionMeta): string {
  return session.title ?? session.id.slice(0, 8);
}

/**
 * Sessions in rail order.
 *
 * `status`: by status, then by name, then by id. `recent`: by the
 * conversational watermark, newest first, then by id.
 *
 * `statusOf` rather than `session.status`: `pendingReview` is an overlay this
 * side applies over the scan's `finished`, so the pane's effective status is the
 * only one that matches what the row draws. The id tiebreak is what makes either
 * order total — two rows that tie on everything else must not depend on which
 * order the scan happened to walk the directory in.
 */
export function sortSessions<T extends SessionMeta>(
  sessions: readonly T[],
  statusOf: (session: T) => SessionStatus,
  sort: SessionSort = "status",
): T[] {
  if (sort === "recent") {
    return [...sessions].sort(
      (a, b) => b.lastActivityMs - a.lastActivityMs || a.id.localeCompare(b.id),
    );
  }
  const rank = (session: T) => RANK.get(statusOf(session)) ?? STATUS_ORDER.length;
  return [...sessions].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      sortLabel(a).localeCompare(sortLabel(b), undefined, {
        sensitivity: "base",
        numeric: true,
      }) ||
      a.id.localeCompare(b.id),
  );
}
