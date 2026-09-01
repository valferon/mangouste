/**
 * The editor's blame column: what each row says, and whether the column shows.
 *
 * Blame is read from git per file (see `gitBlame`), so everything here is
 * presentation: which lines get a label, how old a commit reads at a glance, and
 * what the tooltip spells out in full.
 *
 * The on/off flag lives in this module rather than in `App` for the same reason
 * `editorFacts` does: file editors stay mounted when hidden, so the switch has
 * to be one fact every one of them reads — a per-editor `useState` would leave a
 * tab behind showing the column after it was turned off in the tab in front.
 */

import { KEYS, readBoolean, writeBoolean } from "./persist";
import type { Blame, BlameCommit } from "./types";

/**
 * git's sha for a line that is not committed yet: all zeros.
 *
 * Those lines are labelled rather than left blank — "this line is yours and
 * unsaved" is the most useful thing the column can say about it.
 */
export function isUncommitted(sha: string): boolean {
  return sha.length > 0 && /^0+$/.test(sha);
}

/** What the column writes in the author position. */
export function blameAuthor(commit: BlameCommit): string {
  // git's own wording is "Not Committed Yet", which is a sentence where a name
  // belongs. In a 20-character column it is also most of the room there is.
  if (isUncommitted(commit.sha)) return "Uncommitted";
  return commit.author;
}

/**
 * Compact age, in the units the Git History list uses.
 *
 * One unit and no "ago": the column is a scan, not a sentence, and the exact
 * timestamp is a hover away in `blameTitle`.
 */
export function blameAge(timestamp: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const seconds = Math.max(0, nowMs / 1000 - timestamp);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  if (seconds < 2629800) return `${Math.floor(seconds / 604800)}w`;
  if (seconds < 31557600) return `${Math.floor(seconds / 2629800)}mo`;
  return `${Math.floor(seconds / 31557600)}y`;
}

/** The full story, for the hover. */
export function blameTitle(commit: BlameCommit): string {
  if (isUncommitted(commit.sha)) {
    return "Not committed yet — this line exists only in your working tree.";
  }
  const when = new Date(commit.timestamp * 1000);
  const stamp = Number.isFinite(when.getTime()) ? when.toLocaleString() : "";
  const who = commit.authorEmail ? `${commit.author} <${commit.authorEmail}>` : commit.author;
  return [`${commit.shortSha} ${commit.summary}`, who, stamp].filter(Boolean).join("\n");
}

export interface BlameRow {
  commit: BlameCommit;
  /**
   * Whether this line starts a run of lines from the same commit.
   *
   * Only the first line of a run is labelled — a block of twenty lines from one
   * commit repeating one name twenty times is noise, and the gap is what makes
   * the blocks readable as blocks.
   */
  first: boolean;
}

/**
 * One row per line of the blamed file.
 *
 * A line whose commit index is out of range is dropped rather than guessed at:
 * the only way to get one is a payload this build cannot read, and a wrong name
 * beside a line is worse than no name.
 */
export function blameRows(blame: Blame): BlameRow[] {
  const rows: BlameRow[] = [];
  let previous: string | null = null;
  for (const at of blame.lines) {
    const commit = blame.commits[at];
    if (!commit) {
      previous = null;
      continue;
    }
    rows.push({ commit, first: commit.sha !== previous });
    previous = commit.sha;
  }
  return rows;
}

/* ---------- the switch ----------
 *
 * A version counter as the snapshot, as in `editorFacts`: `useSyncExternalStore`
 * wants something stable to compare, and a boolean read straight out of storage
 * on every render is not it.
 */

let shown = readBoolean(KEYS.prefs.blame, false);
let version = 0;
const listeners = new Set<() => void>();

export function blameShown(): boolean {
  return shown;
}

export function setBlameShown(next: boolean): void {
  if (shown === next) return;
  shown = next;
  writeBoolean(KEYS.prefs.blame, next);
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeBlame(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function blameVersion(): number {
  return version;
}
