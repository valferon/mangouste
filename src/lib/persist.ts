/**
 * Everything the app keeps in `localStorage`, and the one place that says so.
 *
 * Two problems this solves. The keys were scattered across eight modules, so
 * nothing could enumerate what a "reset" would have to clear or what a migration
 * would have to touch. And every read trusted what it found: `JSON.parse(...) as
 * T` is a lie the type system cannot catch, so a shape written by a future build
 * — or a hand-edited value, or a half-written entry from a crash — became a
 * typed object that blew up somewhere far from here.
 *
 * Reads are validated at the boundary instead, and fall back rather than throw.
 * A preference is never worth a blank pane.
 */

/**
 * Bump when a stored shape changes in a way this build cannot read.
 *
 * Adding a key does not need a bump: an absent key already falls back. Only
 * changing what an existing key *means* does.
 */
export const SCHEMA_VERSION = 1;

/**
 * Every persisted key.
 *
 * Grouped by what forgets them: `state` is where you left the workbench,
 * `prefs` is what you chose, `overlay` is your opinion of the sessions on disk.
 * The distinction is what lets a future "reset layout" clear one group without
 * touching the others.
 */
export const KEYS = {
  state: {
    workspaceRoot: "mangouste.workspaceRoot",
    activeRepo: "mangouste.activeRepo",
    sidebarView: "mangouste.sidebarView",
    leftWidth: "mangouste.leftWidth",
    rightWidth: "mangouste.rightWidth",
    terminalHeight: "mangouste.terminalHeight",
    terminalWidth: "mangouste.terminalWidth",
    terminalDock: "mangouste.terminalDock",
    openTabs: "mangouste.openTabs",
    activeTab: "mangouste.activeTab",
    terminalOpen: "mangouste.terminalOpen",
    chatOpen: "mangouste.chatOpen",
  },
  prefs: {
    theme: "mangouste.theme",
    zoom: "mangouste.zoom",
    permissionMode: "mangouste.permissionMode",
    model: "mangouste.model",
    usageEnabled: "mangouste.usageEnabled",
    cliDebug: "mangouste.cliDebug",
    restoreTabs: "mangouste.restoreTabs",
  },
  overlay: {
    sessionsSeen: "mangouste.sessionsSeen",
    sessionsArchived: "mangouste.sessionsArchived",
  },
} as const;

const SCHEMA_KEY = "mangouste.schema";

/** Flat list of every key above, for the reset paths and for tests. */
export function allKeys(): string[] {
  return Object.values(KEYS).flatMap((group) => Object.values(group));
}

/**
 * Migrations to run when the stored version is older than this build's.
 *
 * Keyed by the version they produce, applied in ascending order. Empty because
 * nothing has changed shape yet — the hook exists so the first change is a
 * function here rather than a fresh guess at how to detect old data.
 */
const MIGRATIONS: Record<number, () => void> = {};

export type StoreState = "fresh" | "current" | "migrated" | "from-newer";

/**
 * Reconcile the store with this build. Call once, before anything reads.
 *
 * An unstamped store is treated as version 1 rather than wiped: that is what
 * every existing install looks like, and their archive and read state is real
 * data worth keeping. A store from a *newer* build is left exactly as it is —
 * downgrades happen, the newer build may be the one they go back to, and the
 * validated reads below already refuse anything they cannot parse.
 */
export function initStore(): StoreState {
  let stored: number | null = null;
  try {
    const raw = localStorage.getItem(SCHEMA_KEY);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isInteger(parsed) && parsed > 0) stored = parsed;
    }
  } catch {
    // No store at all (private window, blocked site data). Nothing to do, and
    // every read below will fall back on its own.
    return "fresh";
  }

  const stamp = (): void => {
    try {
      localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION));
    } catch {
      // Unstampable is survivable; it just means we look unstamped next time.
    }
  };

  if (stored === null) {
    // Either a first run or a pre-versioning install. Both are readable as v1.
    const untouched = allKeys().every((key) => localStorage.getItem(key) === null);
    stamp();
    return untouched ? "fresh" : "current";
  }
  if (stored > SCHEMA_VERSION) return "from-newer";
  if (stored === SCHEMA_VERSION) return "current";

  for (let version = stored + 1; version <= SCHEMA_VERSION; version += 1) {
    try {
      MIGRATIONS[version]?.();
    } catch (error) {
      // A migration that throws must not wedge startup. The keys it was fixing
      // stay as they were, and their validated reads fall back.
      console.warn(`store migration to v${version} failed`, error);
    }
  }
  stamp();
  return "migrated";
}

/**
 * Read and validate a JSON value.
 *
 * `isValid` is the point: it is what turns "whatever was in there" into the type
 * the caller claims. A value that fails it is treated as absent.
 */
export function readJson<T>(key: string, fallback: T, isValid: (value: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A full or blocked store costs the preference, not the pane.
  }
}

/** Read a string that must be one of `allowed`. */
export function readEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return allowed.includes(raw as T) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Read a plain string. Empty and missing are the same answer. */
export function readString(key: string, fallback = ""): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // See writeJson.
  }
}

/**
 * Read a boolean stored as the literal "true" or "false".
 *
 * Anything else — a missing key, a torn write, a "1" from some other build — is
 * the fallback, not a guess. StatusPanel's usageEnabled predates this helper and
 * hand-rolls the same encoding over readString/writeString; it is left alone.
 */
export function readBoolean(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

export function writeBoolean(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "true" : "false");
  } catch {
    // See writeJson.
  }
}

/**
 * Read a map of booleans, validated entry by entry.
 *
 * The same principle as cleanFlags in sessionStore.ts: one corrupt entry must
 * not cost every other repo its setting, so the bad entries are dropped and the
 * rest kept. Arrays and null are not plain objects — both parse and both would
 * enumerate as something map-shaped — so they yield {} outright.
 */
export function readBoolMap(key: string): Record<string, boolean> {
  const raw = readJson<Record<string, unknown>>(
    key,
    {},
    (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  );
  const map: Record<string, boolean> = {};
  for (const [entry, flag] of Object.entries(raw)) {
    if (typeof flag === "boolean") map[entry] = flag;
  }
  return map;
}

/** Read a finite number, optionally clamped. Anything else is the fallback. */
export function readNumber(
  key: string,
  fallback: number,
  range?: { min: number; max: number },
): number {
  try {
    const raw = localStorage.getItem(key);
    // Empty is absent, not zero. `Number("")` is 0 and passes `isFinite`, so
    // without this a blank entry becomes a real value — a pane size of 0, a zoom
    // of 0 — instead of falling back.
    if (raw === null || raw.trim() === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    if (!range) return value;
    return Math.min(Math.max(value, range.min), range.max);
  } catch {
    return fallback;
  }
}
