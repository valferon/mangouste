import type { DayStat } from "./types";

/** Day windows for the activity chart. `0` means every day on record. */
export const RANGES = [1, 7, 30, 90, 0] as const;
export type Range = (typeof RANGES)[number];

/**
 * The slice of `days` a window covers, counting today as its first day.
 *
 * Cutting at `now - range` days puts `range + 1` buckets in the window, which
 * passes unnoticed at 90 and is plainly wrong at 1, where a "1d" chart would
 * draw yesterday as well. Days are UTC-bucketed upstream, so the cutoff is too.
 */
export function daysInRange(days: DayStat[], range: Range, now = Date.now()): DayStat[] {
  if (range === 0) return days;
  const cutoff = new Date(now - (range - 1) * 86_400_000).toISOString().slice(0, 10);
  return days.filter((day) => day.day >= cutoff);
}

/** Button text for a window. The unbounded one has no day count to show. */
export function rangeLabel(range: Range): string {
  return range === 0 ? "all" : `${range}d`;
}
