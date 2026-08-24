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
