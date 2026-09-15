/**
 * Clock times down the side of a conversation: whether the column shows, and
 * what each stamp says.
 *
 * The rail already answers "how long ago" for a session as a whole. This
 * answers the other question — when did *this* turn run, and how long was the
 * gap before the next one — which the transcript records and nothing rendered.
 *
 * The on/off flag lives in this module rather than in `App` for the same reason
 * blame's does: chat panes stay mounted when their tab is behind, so the switch
 * has to be one fact every pane reads. A per-pane `useState` would leave the
 * tab you were last in stamped after you turned stamps off in the one in front.
 */

import { KEYS, readBoolean, writeBoolean } from "./persist";

/** What one row's gutter shows. `day` is set only where the date changes. */
export interface ChatStamp {
  time: string;
  day: string | null;
}

/** A row as far as the gutter is concerned: an id, and when it happened. */
export interface StampedRow {
  key: string;
  atMs?: number;
}

/**
 * Stamps for a list of rows, keyed by row key.
 *
 * One stamp per clock minute rather than one per row: a turn is a dozen rows
 * written in the same few seconds, and stamping each would print the same time
 * a dozen times down the gutter. The date joins the first stamp of each day,
 * because a session resumed on Tuesday otherwise shows Monday's turns as a
 * bare "14:32".
 *
 * Rows with no time — live frames carry none of their own until this app
 * stamps them, and a truncated history can lose one — are simply not in the
 * map, and render no stamp.
 */
export function stampsFor(rows: readonly StampedRow[]): Map<string, ChatStamp> {
  const stamps = new Map<string, ChatStamp>();
  let lastTime = "";
  let lastDay = "";
  for (const row of rows) {
    if (row.atMs === undefined) continue;
    const at = new Date(row.atMs);
    if (Number.isNaN(at.getTime())) continue;
    // `numeric` hour, not `2-digit`: a 12-hour locale spends two characters on
    // "AM" already, and the gutter is 52px wide.
    const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const day = at.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
    // Same minute as the last stamped row: that row already says it.
    if (time === lastTime && day === lastDay) continue;
    stamps.set(row.key, { time, day: day === lastDay ? null : day });
    lastTime = time;
    lastDay = day;
  }
  return stamps;
}

/** The full date and time, for the stamp's tooltip. */
export function stampTitle(atMs: number): string {
  return new Date(atMs).toLocaleString();
}

/* ---------- the switch ----------
 *
 * A version counter as the snapshot, as in `blame.ts`: `useSyncExternalStore`
 * wants something stable to compare, and a boolean read straight out of
 * storage on every render is not it.
 */

let shown = readBoolean(KEYS.prefs.chatTimes, false);
let version = 0;
const listeners = new Set<() => void>();

export function chatTimesShown(): boolean {
  return shown;
}

export function setChatTimesShown(next: boolean): void {
  if (shown === next) return;
  shown = next;
  writeBoolean(KEYS.prefs.chatTimes, next);
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeChatTimes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function chatTimesVersion(): number {
  return version;
}
