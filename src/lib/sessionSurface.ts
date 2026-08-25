/**
 * What a session tab holds: this app's chat pane, or `claude` itself.
 *
 * Both are sessions and both sit in the centre strip — the choice is which
 * program you are talking to, not where it lives. The chat pane is a stream-json
 * client: it drives the CLI over a pipe and renders the frames itself, which is
 * what makes the transcript view, the token counts and the status dots possible.
 * What it is not is `claude` — the TUI's own permission prompts, its `/`
 * commands, its statusline and whatever the user has configured around it belong
 * to the real terminal program.
 *
 * `terminal` therefore puts the CLI in the tab, in a pty, in place of the pane.
 * Not in the terminal panel at the bottom: that panel is for shells — builds,
 * git, a REPL — and a session is not one of those. A session is the thing the
 * strip is for.
 */
export type SessionSurface = "chat" | "terminal";

/** Every surface, for the stored-value guard. */
export const SESSION_SURFACES: SessionSurface[] = ["chat", "terminal"];

/**
 * Session ids as the transcripts on disk spell them.
 *
 * Checked rather than trusted because the result is typed into a shell. Ids
 * reach this app two ways — minted here as a uuid, and read out of filenames
 * under `~/.claude/projects` — and a filename is not a shape this app gets to
 * assume.
 */
const SESSION_ID = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;

/**
 * A v4 uuid, for naming a session before `claude` has named one.
 *
 * `getRandomValues` rather than `randomUUID`: the latter is gated on a secure
 * context, which is a property of whichever origin the webview happened to serve
 * the app from, and a session id is not worth a runtime that depends on that.
 * The version and variant bits are set so the id is the same shape as the ones
 * the CLI writes — the transcript filenames are these, and the rail matches on
 * them.
 */
export function mintSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/**
 * A fresh session under an id this app chose.
 *
 * `--session-id` rather than letting the CLI mint one, because a terminal
 * session tells this app nothing: there is no stream to read a uuid out of, so
 * without naming the session up front the tab could never be labelled, renamed,
 * resumed or matched against the rail. Choosing it is the only way the tab and
 * the transcript are the same session.
 */
export function claudeStart(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) return "claude";
  return `claude --session-id ${sessionId}`;
}

/**
 * A session that already has a transcript.
 *
 * An id that is not shaped like one starts a new session in the right repo
 * instead of resuming. The branch should never be reached; if it is, that is a
 * safe answer and a `;` reaching the shell is not.
 */
export function claudeResume(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) return "claude";
  return `claude --resume ${sessionId}`;
}

/**
 * The command a session tab's shell is handed.
 *
 * The transcript is what decides: a tab with one is a session to resume, a tab
 * without one has never been written to and is a session to start. Restored tabs
 * always have one — a terminal tab is only persisted once its transcript exists,
 * since `--resume` against a session `claude` never wrote is an error message
 * where a conversation should be.
 */
export function claudeLaunch(sessionId: string, transcript: string | null): string {
  return transcript ? claudeResume(sessionId) : claudeStart(sessionId);
}
