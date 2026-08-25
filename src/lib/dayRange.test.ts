import { describe, expect, it } from "vitest";
import { daysInRange, rangeLabel, RANGES } from "./dayRange";
import type { DayStat, TokenTotals } from "./types";

const EMPTY: TokenTotals = {
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  thinking: 0,
  total: 0,
  turns: 0,
  costUsd: 0,
  noCacheCostUsd: 0,
};

/** Ten consecutive days ending on the 10th, oldest first, as `stats.days` is. */
const DAYS: DayStat[] = Array.from({ length: 10 }, (_, i) => ({
  day: `2026-03-${String(i + 1).padStart(2, "0")}`,
  tokens: EMPTY,
}));

/** Mid-afternoon UTC on the last day, so the window is not sitting on a boundary. */
const NOW = Date.parse("2026-03-10T15:04:00Z");

describe("daysInRange", () => {
  it("counts today as the whole of the 1d window", () => {
    expect(daysInRange(DAYS, 1, NOW).map((day) => day.day)).toEqual(["2026-03-10"]);
  });

  it("draws seven buckets for 7d, not eight", () => {
    const days = daysInRange(DAYS, 7, NOW);
    expect(days).toHaveLength(7);
    expect(days[0].day).toBe("2026-03-04");
    expect(days[6].day).toBe("2026-03-10");
  });

  it("keeps every day on record for the unbounded window", () => {
    expect(daysInRange(DAYS, 0, NOW)).toHaveLength(DAYS.length);
  });

  it("returns everything when the window outruns the record", () => {
    expect(daysInRange(DAYS, 90, NOW)).toHaveLength(DAYS.length);
  });

  it("excludes days that are already past the cutoff", () => {
    expect(daysInRange(DAYS, 7, NOW).some((day) => day.day === "2026-03-03")).toBe(false);
  });

  it("holds just before midnight UTC, where the cutoff is most fragile", () => {
    const lateNow = Date.parse("2026-03-10T23:59:59Z");
    expect(daysInRange(DAYS, 1, lateNow).map((day) => day.day)).toEqual(["2026-03-10"]);
    expect(daysInRange(DAYS, 7, lateNow)).toHaveLength(7);
  });

  it("survives a gap in the record without back-filling", () => {
    const sparse = DAYS.filter((day) => day.day !== "2026-03-08");
    expect(daysInRange(sparse, 7, NOW)).toHaveLength(6);
  });

  it("has nothing to show when the record stops before the window", () => {
    const stale = DAYS.slice(0, 2);
    expect(daysInRange(stale, 1, NOW)).toEqual([]);
  });
});

describe("rangeLabel", () => {
  it("names the unbounded window rather than counting its days", () => {
    expect(rangeLabel(0)).toBe("all");
  });

  it("labels every bounded window with its day count", () => {
    expect(RANGES.filter((range) => range !== 0).map(rangeLabel)).toEqual([
      "1d",
      "7d",
      "30d",
      "90d",
    ]);
  });
});
