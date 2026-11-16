/**
 * Telling conversation from plumbing in a stored transcript.
 *
 * The live stream only carries what was said: a typed turn is rendered by the
 * composer that sent it, and the CLI echoes back nothing it wrote for the model
 * alone. A transcript on disk holds all of it, so a pane that reads one back,
 * on a resume or after a respawn, has to make the cut itself.
 */

import type { ClaudeFrame } from "./types";

/**
 * A record the CLI wrote for the model, which nobody typed.
 *
 * More sits under `type: "user"` than typed turns: the caveat ahead of a
 * command the CLI ran itself (a model switch leaves one), the expanded body of
 * a skill or slash command, system reminders. The CLI flags each `isMeta` and
 * keeps it out of its own transcript view. Rendered here they read as messages
 * from the person, raw tags and all.
 */
export function isMetaRecord(record: ClaudeFrame): boolean {
  return record.isMeta === true;
}
