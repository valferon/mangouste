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
 * Neither level changes how `claude` is spawned: subagent text is always
 * forwarded and `normal` just leaves it out, so a switch applies the instant you
 * pick it and never costs a restart.
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
 * Render what subagents say.
 *
 * A fan-out is precisely when the parent transcript goes quiet for minutes at a
 * time, so this is the level's largest single gain.
 */
export const showsSubagents = (level: FeedbackLevel): boolean => level === "verbose";

/**
 * Extra `claude` args every spawn carries, whatever the level.
 *
 * `--forward-subagent-text` is documented as working only with `--print` and
 * `--output-format stream-json`, which is exactly how `build_args` spawns.
 *
 * Always on rather than per level: there is no control request to start
 * forwarding on a live process, so tying it to `verbose` made every switch a
 * respawn that interrupted the running turn. The price is that every subagent's
 * text and thinking crosses the pipe even at `normal`, where the pane drops it;
 * the gain is that flipping to `verbose` mid fan-out shows what was already said.
 */
export const FEEDBACK_ARGS: readonly string[] = ["--forward-subagent-text"];
