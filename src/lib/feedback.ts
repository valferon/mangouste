/**
 * How much of a turn the transcript shows while it is happening.
 *
 * The problem this solves is not screen real estate — it is that a session you
 * cannot read is a session you cannot stop. So every call is headlined with the
 * model's own description of it, edits show their diff in the flow, and
 * reasoning is inline prose, at both levels:
 *
 * normal  — the above.
 * verbose — plus each call's arguments and output already open (a running
 *           Bash call's output followed live), plus the internals of
 *           subagents, which are otherwise invisible entirely.
 *
 * There used to be a `quiet` below `normal` that folded all of that away. It
 * saved no space worth having and made the rail harder to read, so it went; a
 * stored `quiet` reads back as the default.
 *
 * Only `verbose` changes how `claude` is spawned; `normal` is a decision about
 * frames already on the wire and applies the instant you pick it.
 */
export type FeedbackLevel = "normal" | "verbose";

/** Every level, in order, for the switch and the stored-value guard. */
export const FEEDBACK_LEVELS: FeedbackLevel[] = ["normal", "verbose"];

/**
 * What the rail does today, and the level nothing has to be explained to reach.
 */
export const FEEDBACK_DEFAULT: FeedbackLevel = "normal";

/** Open every call's arguments and output without a click. */
export const opensTools = (level: FeedbackLevel): boolean => level === "verbose";

/**
 * Tail what is running under the spinner: every process the turn started, and
 * the end of the output file the call is writing.
 *
 * Under the spinner rather than in the call's card, because that is where the
 * eye is while a turn runs; the card can be screens up behind a notice.
 */
export const tailsActivity = (level: FeedbackLevel): boolean => level === "verbose";

/**
 * Ask the CLI to forward what subagents say, and render it.
 *
 * A fan-out is precisely when the parent transcript goes quiet for minutes at a
 * time, so this is the level's largest single gain — and its only cost, since
 * every subagent's text and thinking now crosses the pipe.
 */
export const showsSubagents = (level: FeedbackLevel): boolean => level === "verbose";

/**
 * Extra `claude` args this level needs.
 *
 * `--forward-subagent-text` is documented as working only with `--print` and
 * `--output-format stream-json`, which is exactly how `build_args` spawns.
 *
 * Compared rather than just applied: these take effect at spawn, so the switch
 * uses this to tell a level that is live from one that is waiting on a restart.
 */
export function feedbackArgs(level: FeedbackLevel): string[] {
  return showsSubagents(level) ? ["--forward-subagent-text"] : [];
}

/** Whether moving between two levels needs a respawn to take effect. */
export function feedbackNeedsRestart(from: FeedbackLevel, to: FeedbackLevel): boolean {
  return feedbackArgs(from).join(" ") !== feedbackArgs(to).join(" ");
}
