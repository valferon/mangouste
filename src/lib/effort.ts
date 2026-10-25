/**
 * How hard the model thinks before it answers: the CLI's `--effort` dial.
 *
 * Two ways in, and they do not overlap fully. A level the settings schema knows
 * (`low` to `xhigh`) is spawned as a flag-settings patch, so the control
 * channel's `apply_flag_settings` writes the very layer the process started
 * from and a switch is live on the next request. `max` exists only as the
 * `--effort` flag, which no control request can move, so reaching it or
 * leaving it takes a respawn.
 *
 * `default` passes nothing, letting the user's own `effortLevel` setting win.
 */
export type EffortLevel = "default" | "low" | "medium" | "high" | "xhigh" | "max";

/** Every level, in order, for the switch and the stored-value guard. */
export const EFFORT_LEVELS: EffortLevel[] = ["default", "low", "medium", "high", "xhigh", "max"];

export const EFFORT_DEFAULT: EffortLevel = "default";

/** Levels the flag-settings layer accepts, and so the ones a live switch can set. */
const SETTINGS_LEVELS: ReadonlySet<EffortLevel> = new Set(["low", "medium", "high", "xhigh"]);

/** Extra `claude` args a level needs at spawn. */
export function effortArgs(level: EffortLevel): string[] {
  if (level === "max") return ["--effort", "max"];
  if (SETTINGS_LEVELS.has(level)) return ["--settings", JSON.stringify({ effortLevel: level })];
  return [];
}

/**
 * The `effortLevel` value to hand `apply_flag_settings`, or `undefined` when
 * reaching `to` from a process spawned at `spawned` takes a respawn.
 *
 * Measured from the spawn, not the last live pick: clearing the key (`null`)
 * falls back to the layer the process was launched with, which is `default`
 * only when it was launched with nothing.
 */
export function liveEffortSetting(spawned: EffortLevel, to: EffortLevel): string | null | undefined {
  if (spawned === "max" || to === "max") return undefined;
  if (to === "default") return spawned === "default" ? null : undefined;
  return to;
}
