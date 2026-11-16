/**
 * How hard the model thinks before it answers: the CLI's `--effort` dial.
 *
 * At spawn a level rides as an argument: a flag-settings patch for the ones the
 * settings schema knows (`low` to `xhigh`), the `--effort` flag for `max`, which
 * that schema has no word for.
 *
 * On a live process every level goes over `apply_flag_settings`. The CLI does
 * not treat `effortLevel` there as one more settings key: it sets the session's
 * effort directly, so `max` lands like any other level and `null` drops back to
 * the user's own default whatever the process was launched with. No switch
 * needs a respawn.
 *
 * A switch takes effect from the next turn. A turn in flight keeps the effort it
 * started with for every request it still makes, even though `get_settings`
 * reports the new level at once.
 *
 * Both measured on CLI 2.1.318 to 2.1.322: the level by reading `get_settings`
 * back after each patch, the timing from the `output_config.effort` the
 * transcript records for each API request.
 *
 * `default` passes nothing, letting the user's own `effortLevel` setting win.
 */
export type EffortLevel = "default" | "low" | "medium" | "high" | "xhigh" | "max";

/** Every level, in order, for the switch and the stored-value guard. */
export const EFFORT_LEVELS: EffortLevel[] = ["default", "low", "medium", "high", "xhigh", "max"];

export const EFFORT_DEFAULT: EffortLevel = "default";

/** Levels the flag-settings layer accepts, and so the ones `--settings` can carry at spawn. */
const SETTINGS_LEVELS: ReadonlySet<EffortLevel> = new Set(["low", "medium", "high", "xhigh"]);

/** Extra `claude` args a level needs at spawn. */
export function effortArgs(level: EffortLevel): string[] {
  if (level === "max") return ["--effort", "max"];
  if (SETTINGS_LEVELS.has(level)) return ["--settings", JSON.stringify({ effortLevel: level })];
  return [];
}

/**
 * The `effortLevel` value to hand `apply_flag_settings` on a live process: the
 * level itself, or `null` to clear it back to the user's default.
 */
export function liveEffortSetting(to: EffortLevel): string | null {
  return to === "default" ? null : to;
}

/** What a live switch amounted to, judged from what the session reports. */
export type EffortOutcome =
  /** The session is set to the pick. `running` is the level it named, when it named one. */
  | { kind: "applied"; running: EffortLevel | null }
  /** The patch was acknowledged and the session is set to another level anyway. */
  | { kind: "held"; running: EffortLevel };

/** A level the session can name back; `default` is a choice, never a report. */
function reportedLevel(reported: unknown): EffortLevel | null {
  if (typeof reported !== "string" || reported === "default") return null;
  return EFFORT_LEVELS.find((level) => level === reported) ?? null;
}

/**
 * Compare a pick with `get_settings`' `applied.effort` after the patch.
 *
 * "success" on the patch only says it was taken. A `maxEffortLevel` cap, a
 * `CLAUDE_CODE_EFFORT_LEVEL` in the environment or a CLI that reads the patch
 * differently can leave the session on another level, and the strip must not
 * claim the pick then. A session that names no level (the read failed, or an
 * effort this dial has no word for) has given nothing to contradict the
 * acknowledgement, so the pick stands.
 */
export function effortOutcome(asked: EffortLevel, reported: unknown): EffortOutcome {
  const running = reportedLevel(reported);
  if (running === null || asked === "default" || running === asked) {
    return { kind: "applied", running };
  }
  return { kind: "held", running };
}
