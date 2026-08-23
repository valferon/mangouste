import { useCallback, useMemo, useState } from "react";
import type { SessionMeta, SessionStatus } from "./types";

/**
 * Per-session read/archive overlay, ported from the extension's `SeenStore`.
 *
 * The transcripts are the source of truth for everything the sessions pane shows
 * except these flags, which are opinions about a session rather than facts in
 * it. They live in `localStorage` because they are per-person and per-machine:
 * nothing on disk should change because you archived a row.
 */
const SEEN_KEY = "mangouste.sessionsSeen";
const ARCHIVED_KEY = "mangouste.sessionsArchived";

/**
 * One session's read state.
 *
 * Three fields rather than one timestamp, because "have you seen this" and "you
 * told me to show it again" are different claims and the second has to outrank
 * the first:
 *   w      — the conversational watermark you were shown
 *   seenAt — monotonic clock of when you were shown it
 *   unread — set by "mark unread"; wins while it is above `seenAt`
 */
interface Mark {
  w: number;
  seenAt: number;
  unread: number;
}

const EMPTY: Mark = { w: 0, seenAt: 0, unread: 0 };

/** How many recently-checked sessions stay visually "warm". */
const CHECKED_SET_SIZE = 5;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A full or blocked store costs the flag, not the pane.
  }
}

export interface SessionFlags {
  /**
   * The status to render: `finished` becomes `pendingReview` when you have not
   * looked at the session since its newest turn.
   *
   * This is the whole of `pendingReview` — Rust never reports it. Keeping the
   * overlay in one place is what stops the pane, the counts and the filters
   * disagreeing about what a row is.
   */
  effectiveStatus: (session: SessionMeta) => SessionStatus;
  isReviewed: (session: SessionMeta) => boolean;
  /** Explicitly flagged to come back to, overriding the watermark. */
  isMarkedUnread: (id: string) => boolean;
  /**
   * Among the last few sessions you checked.
   *
   * Rank-based rather than time-based, so a quiet hour does not fade the set you
   * are cycling through and a busy burst does not light up a dozen rows.
   */
  isRecentlyChecked: (id: string) => boolean;
  isArchived: (id: string) => boolean;
  archivedCount: number;
  /**
   * Record that you have looked at this session at its current watermark.
   *
   * A `passive` mark comes from "its pane is open", not from a deliberate open,
   * so it leaves an explicit "mark unread" standing.
   */
  markSeen: (session: SessionMeta, options?: { passive?: boolean }) => void;
  markUnread: (id: string) => void;
  /**
   * Clear the whole backlog in one write. Leaves `seenAt` alone: reviewing in
   * bulk is not the same claim as cycling through each row, so the warm set of
   * recently-checked sessions survives it.
   */
  markAllSeen: (sessions: SessionMeta[]) => void;
  setArchived: (id: string, archived: boolean) => void;
}

export function useSessionFlags(): SessionFlags {
  const [marks, setMarks] = useState<Record<string, Mark>>(() => readJson(SEEN_KEY, {}));
  const [archived, setArchivedMap] = useState<Record<string, boolean>>(() =>
    readJson(ARCHIVED_KEY, {}),
  );

  const markOf = useCallback((id: string): Mark => marks[id] ?? EMPTY, [marks]);

  const isMarkedUnread = useCallback(
    (id: string) => {
      const mark = markOf(id);
      return mark.unread > mark.seenAt;
    },
    [markOf],
  );

  const isReviewed = useCallback(
    (session: SessionMeta) => {
      const mark = markOf(session.id);
      return session.lastActivityMs <= mark.w && mark.unread <= mark.seenAt;
    },
    [markOf],
  );

  const effectiveStatus = useCallback(
    (session: SessionMeta): SessionStatus => {
      if (session.status === "finished" && !isReviewed(session)) return "pendingReview";
      // "Mark unread" has to move the needle on an idle row too: idle is hidden
      // by default, and a status that never changes reads as a broken button.
      if (session.status === "idle" && isMarkedUnread(session.id)) return "pendingReview";
      return session.status;
    },
    [isReviewed, isMarkedUnread],
  );

  /**
   * All mark writes go through one functional updater so the new mark is
   * computed from the state it lands on. Computing it outside `setMarks` let a
   * passive markSeen batched in the same tick tie `unread` with `seenAt` and
   * silently drop a just-clicked "mark unread". Returning null means no change,
   * which skips both the store write and the re-render.
   */
  const update = useCallback(
    (updater: (current: Record<string, Mark>) => Record<string, Mark> | null) => {
      setMarks((current) => {
        const next = updater(current);
        if (!next) return current;
        writeJson(SEEN_KEY, next);
        return next;
      });
    },
    [],
  );

  const markSeen = useCallback(
    (session: SessionMeta, options?: { passive?: boolean }) => {
      update((current) => {
        const previous = current[session.id] ?? EMPTY;
        if (options?.passive) {
          // "Its pane is open" is weaker evidence than a deliberate open: it
          // must not clear an explicit "mark unread", and re-recording an
          // unchanged watermark would loop — every write recreates the flags
          // object, which re-runs the effect that called this.
          if (previous.unread > previous.seenAt) return null;
          if (previous.w >= session.lastActivityMs) return null;
        }
        // Monotonic: a second mark inside the same millisecond must still land
        // above the first, or "mark unread" then "open" could tie and stick.
        const seenAt = Math.max(Date.now(), previous.seenAt + 1);
        // Stamp the wall clock, not just the snapshot's watermark: the list can
        // be up to a scan interval stale, and a record flushed between snapshot
        // and click would flip the row straight back to unread — with nothing
        // to re-mark it, since a resumed chat attaches under a forked id.
        // Records that genuinely postdate the click still re-flag it.
        const w = Math.max(session.lastActivityMs, Date.now());
        return { ...current, [session.id]: { w, seenAt, unread: 0 } };
      });
    },
    [update],
  );

  const markUnread = useCallback(
    (id: string) => {
      update((current) => {
        const previous = current[id] ?? EMPTY;
        // Strictly above the newest seen clock, so the action you just took wins.
        return { ...current, [id]: { ...previous, unread: Math.max(Date.now(), previous.seenAt + 1) } };
      });
    },
    [update],
  );

  const markAllSeen = useCallback(
    (sessions: SessionMeta[]) => {
      update((current) => {
        let changed = false;
        const next = { ...current };
        for (const session of sessions) {
          const previous = next[session.id] ?? EMPTY;
          if (previous.w >= session.lastActivityMs && previous.unread <= previous.seenAt) continue;
          // Same wall-clock stamp as markSeen, for the same staleness reason.
          const w = Math.max(session.lastActivityMs, Date.now());
          next[session.id] = { w, seenAt: previous.seenAt, unread: 0 };
          changed = true;
        }
        return changed ? next : null;
      });
    },
    [update],
  );

  const setArchived = useCallback((id: string, value: boolean) => {
    setArchivedMap((current) => {
      const next = { ...current };
      if (value) next[id] = true;
      else delete next[id];
      writeJson(ARCHIVED_KEY, next);
      return next;
    });
  }, []);

  /** Ids of the `CHECKED_SET_SIZE` most recently seen sessions. */
  const recentlyChecked = useMemo(() => {
    const ranked = Object.entries(marks)
      .filter(([, mark]) => mark.seenAt > 0)
      .sort((a, b) => b[1].seenAt - a[1].seenAt)
      .slice(0, CHECKED_SET_SIZE)
      .map(([id]) => id);
    return new Set(ranked);
  }, [marks]);

  const isRecentlyChecked = useCallback((id: string) => recentlyChecked.has(id), [recentlyChecked]);

  const isArchived = useCallback((id: string) => archived[id] === true, [archived]);
  const archivedCount = useMemo(() => Object.keys(archived).length, [archived]);

  // Memoised as one object: the pane keys `useMemo` and `useEffect` off this
  // value, and a fresh identity per render would re-run all of them.
  return useMemo(
    () => ({
      effectiveStatus,
      isReviewed,
      isMarkedUnread,
      isRecentlyChecked,
      isArchived,
      archivedCount,
      markSeen,
      markUnread,
      markAllSeen,
      setArchived,
    }),
    [
      effectiveStatus,
      isReviewed,
      isMarkedUnread,
      isRecentlyChecked,
      isArchived,
      archivedCount,
      markSeen,
      markUnread,
      markAllSeen,
      setArchived,
    ],
  );
}
