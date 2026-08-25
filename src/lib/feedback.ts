/**
 * How much of a turn the transcript shows while it is happening.
 *
 * The problem this solves is not screen real estate — it is that a session you
 * cannot read is a session you cannot stop. A rail of collapsed `Bash` rows says
 * *that* work is happening and nothing about what it is for, so the moment to
 * interrupt a wrong approach has already passed by the time the wrong edit lands.
 *
 * So the dial is about intent, not volume. Three levels, each a different answer
 * to "how much of the model's own account of itself do you want in the flow":
 *
 * quiet   — the rail as a list of actions. Thinking folds to a chip you open.
 * normal  — every action labelled with the model's own words for it, thinking
 *           inline as prose.
 * verbose — the above, plus each call's arguments and output already open, plus
 *           the internals of subagents, which are otherwise invisible entirely.
 *
 * Only `verbose` changes how `claude` is spawned; the other two are decisions
 * about frames already on the wire and apply the instant you pick them.
 */
export type FeedbackLevel = "quiet" | "normal" | "verbose";

/** Every level, in order, for the switch and the stored-value guard. */
export const FEEDBACK_LEVELS: FeedbackLevel[] = ["quiet", "normal", "verbose"];

/**
 * What the rail does today, and the level nothing has to be explained to reach.
 */
export const FEEDBACK_DEFAULT: FeedbackLevel = "normal";

/**
 * Thinking is a chip to open rather than prose in the flow.
 *
 * Folded rather than dropped: a turn with its reasoning deleted reads as a turn
 * that did not reason, and the whole point of `quiet` is a shorter rail, not a
 * dishonest one.
 */
export const foldsThinking = (level: FeedbackLevel): boolean => level === "quiet";

/**
 * Label a call with the model's own `description` instead of its payload.
 *
 * Every Bash call carries a human-written description and until now it reached
 * only the spinner, where it survives for as long as the call does. `grep -n
 * "MAX_THINKING_TOKENS" -r src-tauri/src src` and "Check thinking env plumbing"
 * are the same call; only one of them is an answer to "why".
 */
export const namesIntent = (level: FeedbackLevel): boolean => level !== "quiet";

/** Open every call's arguments and output without a click. */
export const opensTools = (level: FeedbackLevel): boolean => level === "verbose";

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
