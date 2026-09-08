import { describe, expect, it } from "vitest";
import { createRevealer, type RevealerDeps } from "./reveal";

/** A fake frame clock: frames run only when the test says so, time only moves when told. */
function harness(budgetMs = 6) {
  let clock = 0;
  let nextHandle = 1;
  const frames = new Map<number, () => void>();
  const flushed: string[] = [];
  const deps: RevealerDeps = {
    budgetMs,
    frame: (callback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => void frames.delete(handle),
    now: () => clock,
    flush: (work) => work(),
  };
  const revealer = createRevealer(deps);
  /** Queue a row whose open costs `costMs` of the budget. */
  const add = (name: string, costMs = 0) =>
    revealer.add(() => {
      flushed.push(name);
      clock += costMs;
    });
  /** Run every frame currently scheduled, once. */
  const tick = () => {
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback();
  };
  return { revealer, add, tick, flushed, pending: () => frames.size };
}

describe("the reveal queue", () => {
  it("opens the newest row first, because that is the one on screen", () => {
    const h = harness();
    h.add("old");
    h.add("mid");
    h.add("new");
    h.tick();
    expect(h.flushed).toEqual(["new", "mid", "old"]);
  });

  it("stops for the frame once the budget is spent and picks up in the next", () => {
    const h = harness(6);
    for (const name of ["a", "b", "c", "d", "e"]) h.add(name, 4);
    h.tick();
    // 4ms after the first, still under budget; 8ms after the second, over.
    expect(h.flushed).toEqual(["e", "d"]);
    expect(h.pending()).toBe(1);
    h.tick();
    expect(h.flushed).toEqual(["e", "d", "c", "b"]);
    h.tick();
    expect(h.flushed).toEqual(["e", "d", "c", "b", "a"]);
    expect(h.revealer.idle()).toBe(true);
  });

  it("always opens at least one row per frame, however slow the last was", () => {
    const h = harness(6);
    h.add("huge", 500);
    h.add("also huge", 500);
    h.tick();
    expect(h.flushed).toEqual(["also huge"]);
    h.tick();
    expect(h.flushed).toEqual(["also huge", "huge"]);
  });

  it("lets a row that arrives mid-drain jump the backlog", () => {
    const h = harness(6);
    for (const name of ["h1", "h2", "h3", "h4"]) h.add(name, 4);
    h.tick();
    expect(h.flushed).toEqual(["h4", "h3"]);
    h.add("live", 4);
    h.tick();
    expect(h.flushed.slice(2)).toEqual(["live", "h2"]);
  });

  it("forgets a cancelled row and releases the frame when nothing is left", () => {
    const h = harness();
    const cancelA = h.add("a");
    const cancelB = h.add("b");
    expect(h.revealer.idle()).toBe(false);
    cancelA();
    expect(h.pending()).toBe(1);
    cancelB();
    expect(h.pending()).toBe(0);
    expect(h.revealer.idle()).toBe(true);
    h.tick();
    expect(h.flushed).toEqual([]);
  });

  it("is idle again after the last frame drains", () => {
    const h = harness();
    h.add("only");
    expect(h.revealer.idle()).toBe(false);
    h.tick();
    expect(h.revealer.idle()).toBe(true);
  });
});
