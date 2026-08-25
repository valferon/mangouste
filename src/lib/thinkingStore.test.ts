import { beforeEach, describe, expect, it, vi } from "vitest";
import { KEYS } from "./persist";

const KEY = KEYS.cache.thinkingText;

function fakeStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    _map: map,
  };
}

/**
 * A signature-shaped token. Real ones are ~1000 base64 characters and only the
 * tail is used as the key, so the tests exercise that: two signatures sharing a
 * long head must not be the same entry.
 */
function signature(tail: string): string {
  return `CAIS3QUKpgEIERgCKkDZrbub${"A".repeat(64)}${tail.padStart(40, "z")}`;
}

/** Fresh module per test: the store keeps its list in module scope by design. */
async function load() {
  vi.resetModules();
  return import("./thinkingStore");
}

describe("keeping thinking the transcript throws away", () => {
  let store: ReturnType<typeof fakeStore>;

  beforeEach(() => {
    store = fakeStore();
    vi.stubGlobal("localStorage", store);
  });

  it("gives back what it was told, keyed by signature", async () => {
    const { rememberThinking, recallThinking } = await load();
    rememberThinking(signature("one"), "first thought");
    rememberThinking(signature("two"), "second thought");
    expect(recallThinking(signature("one"))).toBe("first thought");
    expect(recallThinking(signature("two"))).toBe("second thought");
  });

  it("does not confuse two signatures that differ only in their tail", async () => {
    const { rememberThinking, recallThinking } = await load();
    rememberThinking(signature("aaa"), "A");
    rememberThinking(signature("bbb"), "B");
    expect(recallThinking(signature("aaa"))).toBe("A");
    expect(recallThinking(signature("bbb"))).toBe("B");
  });

  it("misses rather than guesses for a block it never saw", async () => {
    const { recallThinking } = await load();
    expect(recallThinking(signature("unseen"))).toBeNull();
  });

  /* A block with no usable signature has no name to be filed under. Both
     directions must be quiet about it: the live render is unaffected either way,
     and a throw here would take down a whole hydrated transcript. */
  it("ignores a missing or too-short signature", async () => {
    const { rememberThinking, recallThinking } = await load();
    expect(() => rememberThinking(undefined, "text")).not.toThrow();
    expect(() => rememberThinking("short", "text")).not.toThrow();
    expect(recallThinking(undefined)).toBeNull();
    expect(recallThinking("short")).toBeNull();
  });

  it("ignores an empty text, so a settled empty block cannot overwrite the real one", async () => {
    const { rememberThinking, recallThinking } = await load();
    rememberThinking(signature("one"), "the reasoning");
    rememberThinking(signature("one"), "");
    expect(recallThinking(signature("one"))).toBe("the reasoning");
  });

  it("takes the later text for a block seen twice", async () => {
    const { rememberThinking, recallThinking } = await load();
    rememberThinking(signature("one"), "partial");
    rememberThinking(signature("one"), "partial and then some");
    expect(recallThinking(signature("one"))).toBe("partial and then some");
  });

  it("survives the reload it exists for", async () => {
    const first = await load();
    first.rememberThinking(signature("one"), "kept across a reload");
    // Same backing store, new module instance: exactly a window reload.
    const second = await load();
    expect(second.recallThinking(signature("one"))).toBe("kept across a reload");
  });

  it("evicts the oldest rather than growing without bound", async () => {
    const { rememberThinking, recallThinking } = await load();
    // Over the 256KB text bound, in blocks large enough to reach it quickly.
    const block = "x".repeat(32 * 1024);
    for (let n = 0; n < 12; n += 1) rememberThinking(signature(`s${n}`), block);
    expect(recallThinking(signature("s0"))).toBeNull();
    expect(recallThinking(signature("s11"))).toBe(block);
    const stored = JSON.parse(store._map.get(KEY) ?? "[]") as unknown[];
    expect(stored.length).toBeLessThan(12);
  });

  it("drops half-written entries on load instead of failing the whole read", async () => {
    store._map.set(
      KEY,
      JSON.stringify([
        { id: "z".repeat(32), text: "good" },
        { id: 7, text: "bad id" },
        { text: "no id" },
        null,
      ]),
    );
    const { recallThinking } = await load();
    expect(recallThinking(`${"q".repeat(20)}${"z".repeat(32)}`)).toBe("good");
  });

  it("treats a store it cannot parse as empty", async () => {
    store._map.set(KEY, "{not json");
    const { recallThinking } = await load();
    expect(recallThinking(signature("one"))).toBeNull();
  });

  it("forgets everything on request", async () => {
    const { rememberThinking, recallThinking, forgetAllThinking } = await load();
    rememberThinking(signature("one"), "text");
    forgetAllThinking();
    expect(recallThinking(signature("one"))).toBeNull();
  });
});
