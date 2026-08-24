/**
 * What the centre pane can hold.
 *
 * Lifted out of `App.tsx` so the menu module can describe a tab's right-click
 * without importing the component that owns the tab list.
 */

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
  /** Resume target. `null` until the CLI reports the uuid for a fresh session. */
  sessionId: string | null;
  /** Transcript path backing `sessionId`, for rendering history on open. */
  resumeFile: string | null;
}

export type Tab =
  | ChatTab
  | { id: string; kind: "file"; label: string; path: string }
  | { id: string; kind: "diff"; label: string; patch: string }
  | { id: string; kind: "dashboard"; label: string };

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
  | { kind: "chat"; cwd: string; sessionId: string; resumeFile: string | null }
  | { kind: "file"; path: string }
  | { kind: "dashboard" };

/** The storable projection of a live tab, or null for what must not come back. */
export function toStoredTab(tab: Tab): StoredTab | null {
  switch (tab.kind) {
    case "chat":
      if (tab.sessionId === null) return null;
      return {
        kind: "chat",
        cwd: tab.cwd,
        sessionId: tab.sessionId,
        resumeFile: tab.resumeFile,
      };
    case "file":
      return { kind: "file", path: tab.path };
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
        (value.resumeFile === null || typeof value.resumeFile === "string")
      );
    case "file":
      return typeof value.path === "string";
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
      };
    case "file":
      return {
        kind: "file",
        id: storedTabId(stored),
        label: stored.path.split("/").pop() ?? stored.path,
        path: stored.path,
      };
    case "dashboard":
      return { kind: "dashboard", id: storedTabId(stored), label: "Dashboard" };
  }
}
