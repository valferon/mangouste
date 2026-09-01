/**
 * What the centre pane can hold.
 *
 * Lifted out of `App.tsx` so the menu module can describe a tab's right-click
 * without importing the component that owns the tab list.
 */

import type { SessionSurface } from "./sessionSurface";

/**
 * A chat tab is one `claude` process.
 *
 * Sessions in the same repo are separate tabs rather than one swapping pane, so
 * switching between them does not tear down a turn that is still streaming.
 */
export interface ChatTab {
  kind: "chat";
  /** Unique tab id, and the chat id the backend routes events by. */
  id: string;
  cwd: string;
  /**
   * Resume target.
   *
   * `null` until the CLI reports the uuid, for a chat-surface tab. A terminal
   * one is minted with its id already set: `claude` in a pty tells this app
   * nothing, so the session is named up front with `--session-id` or the tab
   * could never be labelled, renamed or resumed.
   */
  sessionId: string | null;
  /** Transcript path backing `sessionId`, for rendering history on open. */
  resumeFile: string | null;
  /**
   * Which program the tab holds: this app's chat pane, or `claude` in a pty.
   *
   * Fixed when the tab is opened, not read live off the preference. Switching
   * the setting decides where the *next* session goes; re-pointing a tab that
   * is already holding a live process at a different renderer would orphan it.
   */
  surface: SessionSurface;
}

/**
 * Every tab but the dashboard belongs to exactly one repo.
 *
 * A file tab carries the repo it was opened from rather than deriving one from
 * its path: the path alone cannot say which repo is showing it — a file opened
 * from a chat can sit outside the worktree entirely — and deriving would need
 * an async `gitRoot` call on a code path (the strip's filter, the restore
 * initialiser) that has to be synchronous. The dashboard is the one exception,
 * and deliberately: it is a cross-repo watch surface, and clicking a row on it
 * *switches repo*, so a dashboard owned by a repo would hide itself the moment
 * it was used.
 */
export type Tab =
  | ChatTab
  | { id: string; kind: "file"; label: string; path: string; cwd: string }
  | { id: string; kind: "diff"; label: string; patch: string; cwd: string }
  | { id: string; kind: "history"; label: string; cwd: string }
  | { id: string; kind: "dashboard"; label: string };

/** The repo a tab belongs to, or null for the window-level dashboard. */
export function tabRepo(tab: Tab): string | null {
  return tab.kind === "dashboard" ? null : tab.cwd;
}

/**
 * Whether the strip for `repo` shows this tab.
 *
 * The single answer to that question: App filters the same way in five places —
 * the strip, `visibleTabs`, the restore fallback, the close-and-refocus path
 * and the repo seed — and any two of them disagreeing means a tab that can be
 * focused but not seen, or seen but not closable.
 */
export function tabInRepo(tab: Tab, repo: string): boolean {
  const owner = tabRepo(tab);
  return owner === null || owner === repo;
}

/**
 * What a tab looks like in `localStorage`, for restoring the strip on launch.
 *
 * Deliberately narrower than `Tab`. Two members of the union never come back:
 * diff tabs, whose patch is derived output — storing it would put a whole diff
 * in localStorage, and it would be stale against the worktree by the next run —
 * and chat tabs whose `sessionId` is still null ("New session" tabs), which
 * have no session to resume and no transcript to render, so restoring one
 * would be a blank pane pretending to be history. Labels are not stored either:
 * they are re-derived in `restoreTab` so a rename of the derivation cannot
 * leave stale labels frozen in the store.
 */
export type StoredTab =
  | {
      kind: "chat";
      cwd: string;
      sessionId: string;
      resumeFile: string | null;
      /** Absent in entries written before sessions could run in a terminal. */
      surface?: SessionSurface;
    }
  | { kind: "file"; cwd: string; path: string }
  /** A history tab is its repo and nothing else: everything it shows is read
   *  back from git on open, so there is no derived state to go stale. */
  | { kind: "history"; cwd: string }
  | { kind: "dashboard" };

/** The storable projection of a live tab, or null for what must not come back. */
export function toStoredTab(tab: Tab): StoredTab | null {
  switch (tab.kind) {
    case "chat":
      if (tab.sessionId === null) return null;
      // A terminal tab knows its id from the moment it is minted, so the id
      // alone does not mean there is a session: the transcript does. Restoring
      // one without it would relaunch as `--resume` against something `claude`
      // never wrote, which is an error message where a conversation should be.
      if (tab.surface === "terminal" && tab.resumeFile === null) return null;
      return {
        kind: "chat",
        cwd: tab.cwd,
        sessionId: tab.sessionId,
        resumeFile: tab.resumeFile,
        surface: tab.surface,
      };
    case "file":
      return { kind: "file", cwd: tab.cwd, path: tab.path };
    case "history":
      return { kind: "history", cwd: tab.cwd };
    case "dashboard":
      return { kind: "dashboard" };
    case "diff":
      return null;
  }
}

/** Arrays and null both pass `typeof === "object"`; neither can hold a tab. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shape check for one stored entry, strict enough that `restoreTab` never
 * builds a tab App's own open paths could not have. `resumeFile` must be
 * present: an absent field would come back as `undefined`, and the cold-start
 * path in ChatPane distinguishes "no transcript" (null) from a path to read —
 * `undefined` would thread through as neither.
 */
export function isStoredTab(value: unknown): value is StoredTab {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "chat":
      return (
        typeof value.cwd === "string" &&
        typeof value.sessionId === "string" &&
        (value.resumeFile === null || typeof value.resumeFile === "string") &&
        // Absent is the old shape, which was always a chat pane. A value that
        // is present and is not a surface is corrupt, and drops the entry
        // rather than restoring a tab with no renderer.
        (value.surface === undefined ||
          value.surface === "chat" ||
          value.surface === "terminal")
      );
    case "file":
      // A file entry written before tabs were repo-owned has no cwd, so it
      // fails here and is dropped rather than restored into a strip that has
      // no repo to show it under. One relaunch, one strip of file tabs.
      return typeof value.cwd === "string" && typeof value.path === "string";
    case "history":
      return typeof value.cwd === "string";
    case "dashboard":
      return true;
    default:
      return false;
  }
}

/**
 * Per-entry validation, the same principle as `cleanMarks` in sessionStore.ts:
 * one corrupt entry must not cost every other tab its restore. A non-array —
 * a hand-edited value, a half-written entry from a crash — yields [].
 */
export function cleanStoredTabs(value: unknown): StoredTab[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isStoredTab);
}

/**
 * MUST reproduce the ids App mints: `openSessionTab` and `openFile` in
 * App.tsx, and `DASHBOARD_TAB`. Those paths dedupe by id
 * before opening, so an id that does not match means a restored tab silently
 * duplicates the moment you open the same session or file again.
 */
export function storedTabId(stored: StoredTab): string {
  switch (stored.kind) {
    case "chat":
      return `chat|${stored.cwd}|${stored.sessionId}`;
    case "file":
      return `file:${stored.path}`;
    case "history":
      return `history|${stored.cwd}`;
    case "dashboard":
      return "dashboard";
  }
}

/**
 * The full Tab a stored entry comes back as. The file label matches what
 * `openFile` in App.tsx would mint, so a restored tab and a freshly opened
 * one are indistinguishable in the strip.
 */
export function restoreTab(stored: StoredTab): Tab {
  switch (stored.kind) {
    case "chat":
      return {
        kind: "chat",
        id: storedTabId(stored),
        cwd: stored.cwd,
        sessionId: stored.sessionId,
        resumeFile: stored.resumeFile,
        surface: stored.surface ?? "chat",
      };
    case "file":
      return {
        kind: "file",
        id: storedTabId(stored),
        label: stored.path.split("/").pop() ?? stored.path,
        path: stored.path,
        cwd: stored.cwd,
      };
    case "history":
      return {
        kind: "history",
        id: storedTabId(stored),
        label: "History",
        cwd: stored.cwd,
      };
    case "dashboard":
      return { kind: "dashboard", id: storedTabId(stored), label: "Dashboard" };
  }
}
