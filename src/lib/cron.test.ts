import { describe, expect, it } from "vitest";
import { cronMatches, formatRun, nextRun, parseCron, type Cron } from "./cron";

function cron(expression: string): Cron {
  const parsed = parseCron(expression);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.cron;
}

/** Local-time constructor, so the tests mean the same in every timezone. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe("parseCron", () => {
  it("accepts the common shapes", () => {
    for (const expression of [
      "* * * * *",
      "*/15 9-17 * * mon-fri",
      "0 9 * * 1-5",
      "5,35 */2 1,15 jan-jun 0",
      "0 0 * * 7",
      "@daily",
      "  30 8 * * *  ",
    ]) {
      expect(parseCron(expression).ok).toBe(true);
    }
  });

  it("refuses the wrong field count", () => {
    expect(parseCron("* * * *")).toEqual({
      ok: false,
      error: "expected 5 fields: minute hour day month weekday",
    });
    expect(parseCron("").ok).toBe(false);
  });

  it("refuses out-of-range values and junk", () => {
    expect(parseCron("60 * * * *").ok).toBe(false);
    expect(parseCron("* 24 * * *").ok).toBe(false);
    expect(parseCron("* * 0 * *").ok).toBe(false);
    expect(parseCron("* * * 13 *").ok).toBe(false);
    expect(parseCron("*/0 * * * *").ok).toBe(false);
    expect(parseCron("5-1 * * * *").ok).toBe(false);
    expect(parseCron("x * * * *").ok).toBe(false);
    expect(parseCron("1/2/3 * * * *").ok).toBe(false);
  });

  it("expands steps, ranges and names", () => {
    const parsed = cron("*/20 9-11 * feb sun");
    expect([...parsed.minute]).toEqual([0, 20, 40]);
    expect([...parsed.hour]).toEqual([9, 10, 11]);
    expect([...parsed.month]).toEqual([2]);
    expect([...parsed.dow]).toEqual([0]);
  });

  it("reads a start with a step as running to the end", () => {
    expect([...cron("50/5 * * * *").minute]).toEqual([50, 55]);
  });

  it("folds 7 onto Sunday", () => {
    expect([...cron("0 0 * * 7").dow]).toEqual([0]);
  });
});

describe("cronMatches", () => {
  it("matches weekday mornings", () => {
    const weekdays = cron("0 9 * * 1-5");
    expect(cronMatches(weekdays, at(2026, 10, 5, 9, 0))).toBe(true); // Monday
    expect(cronMatches(weekdays, at(2026, 10, 4, 9, 0))).toBe(false); // Sunday
    expect(cronMatches(weekdays, at(2026, 10, 5, 9, 1))).toBe(false);
  });

  it("ORs the day fields when both are restricted", () => {
    const either = cron("0 0 1 * mon");
    expect(cronMatches(either, at(2026, 10, 1))).toBe(true); // the 1st, a Thursday
    expect(cronMatches(either, at(2026, 10, 5))).toBe(true); // a Monday
    expect(cronMatches(either, at(2026, 10, 6))).toBe(false);
  });

  it("ANDs them when one is a star", () => {
    expect(cronMatches(cron("0 0 1 * *"), at(2026, 10, 5))).toBe(false);
  });
});

describe("nextRun", () => {
  it("is strictly after the given time", () => {
    expect(nextRun(cron("0 9 * * *"), at(2026, 10, 5, 9, 0))).toEqual(at(2026, 10, 6, 9, 0));
    expect(nextRun(cron("0 9 * * *"), at(2026, 10, 5, 8, 59))).toEqual(at(2026, 10, 5, 9, 0));
  });

  it("ignores seconds on the start", () => {
    const from = new Date(at(2026, 10, 5, 8, 59).getTime() + 30_000);
    expect(nextRun(cron("* * * * *"), from)).toEqual(at(2026, 10, 5, 9, 0));
  });

  it("skips to the next weekday", () => {
    // Friday evening to Monday morning.
    expect(nextRun(cron("30 8 * * 1-5"), at(2026, 10, 9, 18, 0))).toEqual(at(2026, 10, 12, 8, 30));
  });

  it("finds a leap day", () => {
    expect(nextRun(cron("0 0 29 2 *"), at(2026, 10, 5))).toEqual(at(2028, 2, 29));
  });

  it("is null for a date that never comes", () => {
    expect(nextRun(cron("0 0 31 2 *"), at(2026, 10, 5))).toBeNull();
  });
});

describe("formatRun", () => {
  const now = at(2026, 10, 5, 10, 0);

  it("says only the time for today", () => {
    expect(formatRun(at(2026, 10, 5, 17, 30), now)).not.toMatch(/tomorrow/);
  });

  it("says tomorrow", () => {
    expect(formatRun(at(2026, 10, 6, 9, 0), now)).toMatch(/^tomorrow /);
  });
});
