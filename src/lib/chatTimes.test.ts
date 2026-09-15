import { describe, expect, it } from "vitest";

import {
  chatTimesShown,
  chatTimesVersion,
  setChatTimesShown,
  stampsFor,
  subscribeChatTimes,
} from "./chatTimes";

/** A fixed instant, plus offsets, so nothing here depends on the clock. */
const AT = Date.UTC(2026, 8, 9, 12, 30, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe("stampsFor", () => {
  it("stamps one row per clock minute, not every row of a turn", () => {
    const stamps = stampsFor([
      { key: "a", atMs: AT },
      { key: "b", atMs: AT + 1_000 },
      { key: "c", atMs: AT + 20_000 },
      { key: "d", atMs: AT + 2 * MINUTE },
    ]);
    // b and c are the same minute as a, which already says it.
    expect([...stamps.keys()]).toEqual(["a", "d"]);
    expect(stamps.get("a")?.time).toMatch(/\d{1,2}:\d{2}/);
    expect(stamps.get("d")?.time).not.toBe(stamps.get("a")?.time);
  });

  it("names the day on the first stamp, and again only when it changes", () => {
    const stamps = stampsFor([
      { key: "a", atMs: AT },
      { key: "b", atMs: AT + MINUTE },
      // Two days on, so the date differs in every timezone.
      { key: "c", atMs: AT + 2 * DAY },
    ]);
    expect(stamps.get("a")?.day).toBeTruthy();
    expect(stamps.get("b")?.day).toBeNull();
    expect(stamps.get("c")?.day).toBeTruthy();
    expect(stamps.get("c")?.day).not.toBe(stamps.get("a")?.day);
  });

  it("leaves out rows with no usable time, rather than guessing one", () => {
    const stamps = stampsFor([
      { key: "live" },
      { key: "torn", atMs: Number.NaN },
      { key: "real", atMs: AT },
    ]);
    expect([...stamps.keys()]).toEqual(["real"]);
  });

  it("is empty for an empty log", () => {
    expect(stampsFor([]).size).toBe(0);
  });
});

describe("the switch", () => {
  it("is off until asked for, and tells every pane when it moves", () => {
    const seen: number[] = [];
    const stop = subscribeChatTimes(() => seen.push(chatTimesVersion()));
    expect(chatTimesShown()).toBe(false);

    setChatTimesShown(true);
    expect(chatTimesShown()).toBe(true);
    expect(seen).toHaveLength(1);

    // Setting what is already set is not a change, so nothing re-renders.
    setChatTimesShown(true);
    expect(seen).toHaveLength(1);

    setChatTimesShown(false);
    expect(chatTimesShown()).toBe(false);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(seen[0]);

    stop();
    setChatTimesShown(true);
    expect(seen).toHaveLength(2);
    setChatTimesShown(false);
  });
});
