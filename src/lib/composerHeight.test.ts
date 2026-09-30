import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPOSER_DEFAULT,
  COMPOSER_MAX,
  COMPOSER_MIN,
  composerHeight,
  composerHeightFrom,
  resetComposerHeight,
  resizeComposer,
  setComposerHeight,
  subscribeComposerHeight,
} from "./composerHeight";

describe("composerHeightFrom", () => {
  it("falls back to the default for a missing or collapsed value", () => {
    expect(composerHeightFrom(0)).toBe(COMPOSER_DEFAULT);
    expect(composerHeightFrom(-40)).toBe(COMPOSER_DEFAULT);
    expect(composerHeightFrom(Number.NaN)).toBe(COMPOSER_DEFAULT);
  });

  it("clamps a stored height into range", () => {
    expect(composerHeightFrom(10)).toBe(COMPOSER_MIN);
    expect(composerHeightFrom(5000)).toBe(COMPOSER_MAX);
    expect(composerHeightFrom(180.6)).toBe(181);
  });
});

describe("the shared height", () => {
  afterEach(() => {
    resetComposerHeight();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("tells every subscriber, so hidden panes follow a drag in the front one", () => {
    const heard: number[] = [];
    const stop = subscribeComposerHeight(() => heard.push(composerHeight()));
    resizeComposer(40);
    resizeComposer(20);
    stop();
    resizeComposer(10);
    expect(heard).toEqual([COMPOSER_DEFAULT + 40, COMPOSER_DEFAULT + 60]);
  });

  it("stays in range however far the pointer goes", () => {
    resizeComposer(10_000);
    expect(composerHeight()).toBe(COMPOSER_MAX);
    resizeComposer(-10_000);
    expect(composerHeight()).toBe(COMPOSER_MIN);
  });

  it("does not notify when a clamp leaves the height where it was", () => {
    setComposerHeight(COMPOSER_MIN);
    const listener = vi.fn();
    const stop = subscribeComposerHeight(listener);
    resizeComposer(-30);
    stop();
    expect(listener).not.toHaveBeenCalled();
  });

  it("writes once per drag, after it settles", () => {
    vi.useFakeTimers();
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem });
    resizeComposer(10);
    resizeComposer(10);
    resizeComposer(10);
    expect(setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledWith("mangouste.composerHeight", String(COMPOSER_DEFAULT + 30));
  });
});
