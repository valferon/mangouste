import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  allKeys,
  initStore,
  KEYS,
  readBoolean,
  readBoolMap,
  readEnum,
  readJson,
  readNumber,
  readString,
  SCHEMA_VERSION,
  writeBoolean,
  writeJson,
} from "./persist";

/** A `localStorage` that behaves, and one that refuses, since both really happen. */
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
    /** Test-only view, not part of the Storage interface. */
    _map: map,
  };
}

function hostileStore() {
  return {
    getItem: () => {
      throw new DOMException("blocked");
    },
    setItem: () => {
      throw new DOMException("blocked");
    },
    removeItem: () => {},
    clear: () => {},
    length: 0,
    key: () => null,
  };
}

const SCHEMA_KEY = "mangouste.schema";

describe("the key catalogue", () => {
  it("has no duplicate keys across the groups", () => {
    const keys = allKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("namespaces every key, so a reset cannot touch another app's storage", () => {
    expect(allKeys().every((key) => key.startsWith("mangouste."))).toBe(true);
  });

  it("does not claim the schema key itself, which is not app state", () => {
    expect(allKeys()).not.toContain(SCHEMA_KEY);
  });
});

describe("initStore", () => {
  it("reports a first run and stamps the version", () => {
    const store = fakeStore();
    vi.stubGlobal("localStorage", store);
    expect(initStore()).toBe("fresh");
    expect(store.getItem(SCHEMA_KEY)).toBe(String(SCHEMA_VERSION));
  });

  it("adopts an unstamped store that already holds data, and keeps it", () => {
    // The case every existing install is in. Wiping here would throw away read
    // and archive state that is real, unrecoverable, user-generated data.
    const store = fakeStore({ [KEYS.overlay.sessionsArchived]: '{"abc":true}' });
    vi.stubGlobal("localStorage", store);
    expect(initStore()).toBe("current");
    expect(store.getItem(KEYS.overlay.sessionsArchived)).toBe('{"abc":true}');
    expect(store.getItem(SCHEMA_KEY)).toBe(String(SCHEMA_VERSION));
  });

  it("recognises a store this build already wrote", () => {
    vi.stubGlobal("localStorage", fakeStore({ [SCHEMA_KEY]: String(SCHEMA_VERSION) }));
    expect(initStore()).toBe("current");
  });

  it("leaves a store from a newer build untouched", () => {
    // A downgrade. The newer build may be the one they go back to, so its data
    // survives; the validated reads below are what keep it from being misread.
    const store = fakeStore({
      [SCHEMA_KEY]: String(SCHEMA_VERSION + 5),
      [KEYS.prefs.theme]: "dark",
    });
    vi.stubGlobal("localStorage", store);
    expect(initStore()).toBe("from-newer");
    expect(store.getItem(SCHEMA_KEY)).toBe(String(SCHEMA_VERSION + 5));
    expect(store.getItem(KEYS.prefs.theme)).toBe("dark");
  });

  it("treats a garbage stamp as unstamped rather than as a version", () => {
    const store = fakeStore({ [SCHEMA_KEY]: "not-a-number" });
    vi.stubGlobal("localStorage", store);
    expect(initStore()).toBe("fresh");
    expect(store.getItem(SCHEMA_KEY)).toBe(String(SCHEMA_VERSION));
  });

  it("survives a store that throws on every access", () => {
    vi.stubGlobal("localStorage", hostileStore());
    expect(initStore()).toBe("fresh");
  });
});

describe("readEnum", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStore({ good: "dark", bad: "chartreuse" }));
  });

  it("returns a stored value that is in the set", () => {
    expect(readEnum("good", ["light", "dark"] as const, "light")).toBe("dark");
  });

  it("falls back on a value outside the set", () => {
    expect(readEnum("bad", ["light", "dark"] as const, "light")).toBe("light");
  });

  it("falls back on a missing key", () => {
    expect(readEnum("absent", ["light", "dark"] as const, "light")).toBe("light");
  });
});

describe("readNumber", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "localStorage",
      fakeStore({ n: "42", junk: "wide", empty: "", huge: "99999", nan: "NaN" }),
    );
  });

  it("parses a number", () => {
    expect(readNumber("n", 7)).toBe(42);
  });

  it("clamps into range when one is given", () => {
    expect(readNumber("huge", 7, { min: 0, max: 100 })).toBe(100);
  });

  it("falls back on anything unparseable", () => {
    expect(readNumber("junk", 7)).toBe(7);
    expect(readNumber("nan", 7)).toBe(7);
    expect(readNumber("absent", 7)).toBe(7);
  });

  it("treats an empty string as absent, not as zero", () => {
    // `Number("")` is 0, which would silently become a collapsed pane size.
    expect(readNumber("empty", 7)).toBe(7);
  });
});

describe("readJson", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "localStorage",
      fakeStore({ obj: '{"a":1}', arr: "[1,2]", torn: '{"a":' }),
    );
  });

  const isObject = (value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  it("returns a value that satisfies the guard", () => {
    expect(readJson("obj", {}, isObject)).toEqual({ a: 1 });
  });

  it("falls back when the guard rejects the shape", () => {
    expect(readJson("arr", { fallback: true }, isObject)).toEqual({ fallback: true });
  });

  it("falls back on a half-written value rather than throwing", () => {
    // A crash mid-write leaves exactly this.
    expect(readJson("torn", { fallback: true }, isObject)).toEqual({ fallback: true });
  });
});

describe("readBoolean", () => {
  it("round-trips what writeBoolean stored", () => {
    vi.stubGlobal("localStorage", fakeStore());
    writeBoolean("flag", true);
    expect(readBoolean("flag", false)).toBe(true);
    writeBoolean("flag", false);
    expect(readBoolean("flag", true)).toBe(false);
  });

  it("falls back on anything that is not the literal true or false", () => {
    // "1", "yes", a torn write — none of them get to mean anything.
    vi.stubGlobal("localStorage", fakeStore({ junk: "1", torn: "tru" }));
    expect(readBoolean("junk", true)).toBe(true);
    expect(readBoolean("torn", false)).toBe(false);
    expect(readBoolean("absent", true)).toBe(true);
  });
});

describe("readBoolMap", () => {
  it("drops a bad entry and keeps the rest", () => {
    // One corrupt entry costs one entry, not every repo's setting.
    vi.stubGlobal(
      "localStorage",
      fakeStore({ map: '{"a":true,"b":"yes","c":false,"d":1}' }),
    );
    expect(readBoolMap("map")).toEqual({ a: true, c: false });
  });

  it("yields an empty map for an array", () => {
    // An array parses and enumerates like a map, so it needs its own refusal.
    vi.stubGlobal("localStorage", fakeStore({ map: "[true,false]" }));
    expect(readBoolMap("map")).toEqual({});
  });

  it("yields an empty map for null", () => {
    // `typeof null` is "object"; the guard must not be fooled by it.
    vi.stubGlobal("localStorage", fakeStore({ map: "null" }));
    expect(readBoolMap("map")).toEqual({});
  });

  it("yields an empty map for a missing key", () => {
    vi.stubGlobal("localStorage", fakeStore());
    expect(readBoolMap("absent")).toEqual({});
  });
});

describe("write failures", () => {
  it("swallow a blocked store instead of taking the caller down", () => {
    vi.stubGlobal("localStorage", hostileStore());
    expect(() => writeJson("k", { a: 1 })).not.toThrow();
    expect(readString("k", "fallback")).toBe("fallback");
  });

  it("leave the boolean helpers on their fallbacks, never throwing", () => {
    vi.stubGlobal("localStorage", hostileStore());
    expect(() => writeBoolean("k", true)).not.toThrow();
    expect(readBoolean("k", true)).toBe(true);
    expect(readBoolean("k", false)).toBe(false);
    expect(readBoolMap("k")).toEqual({});
  });
});
