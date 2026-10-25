/**
 * Following a Bash call's output while it runs.
 *
 * A running call's card shows its output live where the result will land, so
 * opening the card is following it. `verbose` follows everything under the
 * spinner instead, with every process the turn has running. A backgrounded call's card is finished the moment it
 * launches; its output goes on in a file the result names, read from here.
 */

/** The same two heads `sessions.rs` reads (`BACKGROUND_STARTS`). */
const LAUNCH =
  /^\s*(?:Command running in background with ID: |Command [^\n]*?was moved to the background \(ID: )([\w-]+)[\s\S]*?Output is being written to: (.+?)(?:\.\s|\.$|$)/;

export interface BackgroundLaunch {
  id: string;
  outputPath: string;
}

/**
 * The task a Bash result says it backgrounded, or null for any other result.
 *
 * Anchored on the result's opening sentence, as the Rust side is: a `cat` of a
 * file that contains these words is output, not a launch.
 */
export function parseBackgroundLaunch(text: string): BackgroundLaunch | null {
  const match = LAUNCH.exec(text);
  if (!match) return null;
  const outputPath = match[2].trim();
  return outputPath === "" ? null : { id: match[1], outputPath };
}
