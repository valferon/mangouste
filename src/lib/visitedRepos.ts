/**
 * Repos you have looked at, whether or not you ever talked to one there.
 *
 * The sessions rail is built out of transcripts, so a repo you opened to read
 * code has nothing to be built out of: no session, no project directory, no
 * row. That is the one case where the rail forgets where you have been — you
 * switch to a tree, read a file, switch away, and the only way back is the repo
 * picker again.
 *
 * A visit is therefore recorded here, and a visited repo with no sessions gets a
 * header row of its own with nothing under it. The row is not decoration: its
 * label switches the workbench to that tree and its `+` starts a session there,
 * which are exactly the two things you came back for.
 *
 * These are opinions about where *you* have been, not facts about the machine,
 * so they live in `localStorage` beside the archive and pin overlays rather than
 * anywhere on disk.
 */

import { useCallback, useMemo, useState } from "react";
import { KEYS, readJson, writeJson } from "./persist";
import type { ProjectGroup } from "./types";

const VISITED_KEY = KEYS.overlay.reposVisited;

/**
 * When a visit stops counting as recent.
 *
 * Mirrors `IDLE_WINDOW_MS` in `src-tauri/src/sessions.rs`, which is what makes a
 * session `idle` — deliberately the same number, because the rail then hides a
 * stale visit and a stale session on the same schedule and the `idle` toggle
 * brings both back. A repo row that outlived every session row beside it would
 * be a second, invisible retention rule to learn.
 */
export const VISIT_IDLE_AFTER_MS = 24 * 3_600_000;

/**
 * How many visits are kept at all, newest first.
 *
 * A cap rather than an expiry: past the `idle` line a visit is already out of
 * sight, and what is left is only the store's size. Forty is far more repos than
 * a person cycles through, and the oldest falling off is the same thing that
 * would have happened by hand.
 */
export const MAX_VISITED = 40;

/** Absolute repo path to the wall clock when it was last shown. */
export type RepoVisits = Record<string, number>;

/**
 * Drop entries that are not `path: timestamp`, keeping the rest.
 *
 * Per entry, like the session overlay's marks: one hand-edited or half-written
 * value must cost one repo row, not every repo you have visited.
 */
export function cleanVisits(raw: Record<string, unknown>): RepoVisits {
  const visits: RepoVisits = {};
  for (const [path, at] of Object.entries(raw)) {
    if (path.length === 0) continue;
    if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) continue;
    visits[path] = at;
  }
  return visits;
}

/** The `max` newest visits. Returns the input untouched when it already fits. */
export function pruneVisits(visits: RepoVisits, max: number = MAX_VISITED): RepoVisits {
  const entries = Object.entries(visits);
  if (entries.length <= max) return visits;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, max));
}

/**
 * The name Claude Code would give this path's project directory.
 *
 * The inverse of `unescape_dir_name` in `src-tauri/src/sessions.rs`. Used as the
 * placeholder row's `dirName`, which is the rail's React key and its
 * collapsed-state key: spelling it the way the scan would means the row a repo
 * gets before its first session and the group it gets after are the same row,
 * so starting a session does not reset what you collapsed.
 */
export function projectDirName(path: string): string {
  return path.replace(/\//g, "-");
}

/** Last path segment, which is what the scan labels a group with. */
export function repoLabel(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const leaf = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return leaf.length > 0 ? leaf : path;
}

export interface PlaceholderOptions {
  now: number;
  /** The rail's `idle` toggle: visits past the idle line show only with it on. */
  includeIdle: boolean;
  /** Overridable so the tests do not have to sleep for a day. */
  afterMs?: number;
}

/**
 * Header-only groups for the visited repos the rail is not already showing.
 *
 * `covered` is the cwds of the groups that survived filtering, not every cwd the
 * scan returned. The difference is the repo whose only sessions are idle and
 * hidden: it is still a repo you were just in, and the row that takes you back
 * to it is worth more than the consistency of pretending you were not.
 *
 * A placeholder is exactly "a group with no sessions", which the scan itself can
 * never produce — `list_sessions` skips a project directory whose transcripts
 * all failed to parse — so the rail can tell the two apart by `sessions.length`
 * without a flag on the wire type.
 */
export function visitedPlaceholders(
  visits: RepoVisits,
  covered: Iterable<string>,
  options: PlaceholderOptions,
): ProjectGroup[] {
  const afterMs = options.afterMs ?? VISIT_IDLE_AFTER_MS;
  const shown = new Set(covered);
  const out: ProjectGroup[] = [];
  for (const [path, at] of Object.entries(visits)) {
    if (shown.has(path)) continue;
    if (!options.includeIdle && options.now - at > afterMs) continue;
    out.push({
      dirName: projectDirName(path),
      cwd: path,
      label: repoLabel(path),
      sessions: [],
    });
  }
  return out;
}

/**
 * Scanned groups and placeholders in one list, ordered as the scan orders itself.
 *
 * Alphabetical by label with `dirName` breaking ties, which is `list_sessions`'
 * own comparator: a placeholder has to sit where its group will sit once it has
 * sessions, or starting one would make the row jump.
 */
export function withPlaceholders(
  groups: readonly ProjectGroup[],
  placeholders: readonly ProjectGroup[],
): ProjectGroup[] {
  if (placeholders.length === 0) return groups as ProjectGroup[];
  return [...groups, ...placeholders].sort(
    (a, b) =>
      a.label.toLowerCase().localeCompare(b.label.toLowerCase()) ||
      a.dirName.localeCompare(b.dirName),
  );
}

export interface VisitedRepos {
  visits: RepoVisits;
  /** Stamp a repo as shown now. Called on every switch, launch restore included. */
  recordVisit: (path: string) => void;
  /** Drop one repo's visit, which is how a placeholder row is dismissed. */
  forget: (path: string) => void;
}

export function useVisitedRepos(): VisitedRepos {
  const [visits, setVisits] = useState<RepoVisits>(() =>
    pruneVisits(
      cleanVisits(
        readJson<Record<string, unknown>>(
          VISITED_KEY,
          {},
          (value) => typeof value === "object" && value !== null && !Array.isArray(value),
        ),
      ),
    ),
  );

  const recordVisit = useCallback((path: string) => {
    if (!path) return;
    setVisits((current) => {
      // Same-millisecond re-stamps are the common case — an effect that re-runs
      // for a reason other than the path — and a write that changes nothing
      // would still hand every consumer a new object to re-render for.
      const at = Date.now();
      if (current[path] === at) return current;
      const next = pruneVisits({ ...current, [path]: at });
      writeJson(VISITED_KEY, next);
      return next;
    });
  }, []);

  const forget = useCallback((path: string) => {
    setVisits((current) => {
      if (current[path] === undefined) return current;
      const next = { ...current };
      delete next[path];
      writeJson(VISITED_KEY, next);
      return next;
    });
  }, []);

  return useMemo(() => ({ visits, recordVisit, forget }), [visits, recordVisit, forget]);
}
