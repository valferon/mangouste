/**
 * Narrowing a session's changes to the part you asked about.
 *
 * The scan answers one question — what has this session changed since it
 * started — and the pane asks three: what did this turn do, what has happened
 * since I last looked, and what has the whole session done. The difference
 * between them is a cutoff in time, and every file carries the timestamp of the
 * last write the transcript saw, so the narrowing is a filter rather than three
 * scans.
 *
 * What it deliberately does not do is narrow the *content*. A file's patch is
 * cumulative against the session's baseline: reconstructing what one turn alone
 * did to a file would mean holding a copy of the worktree at every turn
 * boundary, and a diff pane is not worth a snapshot regime. So a scope answers
 * "which files", and the patch beside it is honest about being the whole
 * session's work on that file — the header says so.
 */

import type { ChangedFile, SessionChanges } from "./types";

/**
 * How far back the pane is looking.
 *
 * `session` is the default because it is the question with no hidden premise:
 * the other two are only meaningful once you know when the turn started, or
 * when you last read the session.
 */
export type ChangeScope = "turn" | "seen" | "session";

export interface ScopeClock {
  /** When the newest turn began, from the transcript. */
  turnStartMs: number;
  /** The read watermark: when you last looked at this session. */
  seenAtMs: number;
}

/** The cutoff a scope means, or 0 for "everything this session did". */
export function scopeSince(scope: ChangeScope, clock: ScopeClock): number {
  if (scope === "turn") return clock.turnStartMs;
  if (scope === "seen") return clock.seenAtMs;
  return 0;
}

/**
 * Files a scope keeps.
 *
 * A file with no timestamp survives every scope, and that is the deliberate
 * call: `lastTouchMs` is 0 when git found a change that no write tool named —
 * a `sed`, a formatter, a build step — and dropping those would mean a pane
 * that quietly omits real changes to the code. Showing one change too many is a
 * question; hiding one is a lie.
 */
export function filesInScope(files: readonly ChangedFile[], sinceMs: number): ChangedFile[] {
  if (sinceMs <= 0) return [...files];
  return files.filter((file) => file.lastTouchMs === 0 || file.lastTouchMs >= sinceMs);
}

export interface ChangeTotals {
  files: number;
  additions: number;
  deletions: number;
  /** Files git reports as binary, which have counts in neither column. */
  binary: number;
}

export function totals(files: readonly ChangedFile[]): ChangeTotals {
  let additions = 0;
  let deletions = 0;
  let binary = 0;
  for (const file of files) {
    if (file.additions === null && file.deletions === null) binary += 1;
    additions += file.additions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return { files: files.length, additions, deletions, binary };
}

/**
 * The one-line badge: `+124 −31`.
 *
 * A real minus sign rather than a hyphen, to match the `+`, and both sides are
 * always printed — "+40" alone reads as a file that only grew, and the absent
 * half is information.
 */
export function countsLabel(totals: ChangeTotals): string {
  return `+${totals.additions.toLocaleString()} −${totals.deletions.toLocaleString()}`;
}

/** `5 files · +124 −31`, or what to say when a scope is empty. */
export function summaryLabel(totals: ChangeTotals): string {
  if (totals.files === 0) return "no changes";
  const files = `${totals.files} file${totals.files === 1 ? "" : "s"}`;
  const binary = totals.binary > 0 ? ` · ${totals.binary} binary` : "";
  return `${files} · ${countsLabel(totals)}${binary}`;
}

/**
 * What the scope switch offers, and what each one is claiming.
 *
 * A scope whose clock is unknown is offered anyway but disabled: hiding it
 * would make the switch change shape as a session runs, and a greyed control
 * that says why is easier to understand than one that is missing.
 */
export function scopeOptions(
  clock: ScopeClock,
): { scope: ChangeScope; label: string; title: string; disabled: boolean }[] {
  return [
    {
      scope: "turn",
      label: "this turn",
      title:
        clock.turnStartMs > 0
          ? "Files written since the newest turn began"
          : "No turn has started in this session yet",
      disabled: clock.turnStartMs <= 0,
    },
    {
      scope: "seen",
      label: "since seen",
      title:
        clock.seenAtMs > 0
          ? "Files written since you last looked at this session"
          : "You have not read this session yet, so there is no watermark",
      disabled: clock.seenAtMs <= 0,
    },
    {
      scope: "session",
      label: "session",
      title: "Every file this session has changed",
      disabled: false,
    },
  ];
}

/**
 * Whether two scans differ in anything the pane draws.
 *
 * The pane polls, and a poll that changed nothing must not re-render a list the
 * user is scrolling or reset the file they have open. Compared field by field
 * rather than by identity because every poll allocates a fresh object.
 */
export function sameChanges(a: SessionChanges | null, b: SessionChanges | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.base !== b.base || a.files.length !== b.files.length) return false;
  if (a.additions !== b.additions || a.deletions !== b.deletions) return false;
  if (a.unchanged !== b.unchanged || a.fileCount !== b.fileCount) return false;
  return a.files.every((file, index) => {
    const other = b.files[index];
    return (
      file.path === other.path &&
      file.additions === other.additions &&
      file.deletions === other.deletions &&
      file.untracked === other.untracked &&
      file.lastTouchMs === other.lastTouchMs
    );
  });
}
