/**
 * Per-chat session debug log: every frame, stderr line, phase move, probe
 * report and CLI debug line, timestamped, for the drawer behind the status
 * bar's phase chip.
 *
 * Module-level rather than component state so producers (ChatPane, hidden
 * panes included) and the one consumer (DebugLog) need no prop plumbing, and
 * the log survives the drawer being closed.
 */

export interface DebugEntry {
  seq: number;
  /** Wall-clock ms of the first occurrence. */
  at: number;
  kind: "frame" | "stream" | "stderr" | "cli" | "phase" | "probe" | "send" | "permission" | "exit";
  label: string;
  /**
   * Payload for the expanded row, as a capped text snapshot; absent for
   * label-only events.
   */
  payload?: unknown;
  /** Consecutive identical events collapse into one row with a counter. */
  count: number;
}

/** Ring size per chat. Stream deltas coalesce, so this covers a long session. */
const MAX_ENTRIES = 3000;
/** Identical consecutive events within this window collapse into one entry. */
const COALESCE_MS = 2000;
/**
 * Cap per stored payload.
 *
 * A single frame can be megabytes — a file read, a long tool result — and the
 * buffer holds it for the life of the chat, so what goes in is a truncated text
 * snapshot rather than a reference to the live frame.
 */
const MAX_PAYLOAD_CHARS = 64_000;
/** Cap per string field, applied while serializing so the whole one is never built. */
const MAX_FIELD_CHARS = 4_096;

const buffers = new Map<string, DebugEntry[]>();
const listeners = new Set<() => void>();
let seq = 0;
let version = 0;

/** Stringify once, at log time, and truncate. Strings are already the display form. */
function snapshot(payload: unknown): string | undefined {
  if (payload === undefined) return undefined;
  let text: string;
  if (typeof payload === "string") {
    text = payload;
  } else {
    try {
      // Clip inside the serializer, not after it: a frame carrying a 5 MB file
      // read would otherwise be materialized whole on the frame path — which
      // runs for every frame, drawer open or not — and then thrown away.
      text =
        JSON.stringify(
          payload,
          (_key, value) =>
            typeof value === "string" && value.length > MAX_FIELD_CHARS
              ? `${value.slice(0, MAX_FIELD_CHARS)}… truncated, ${value.length - MAX_FIELD_CHARS} more characters`
              : value,
          2,
        ) ?? String(payload);
    } catch {
      // Cycles or a BigInt: the label still carries the useful part.
      text = String(payload);
    }
  }
  if (text.length <= MAX_PAYLOAD_CHARS) return text;
  return `${text.slice(0, MAX_PAYLOAD_CHARS)}\n… truncated, ${text.length - MAX_PAYLOAD_CHARS} more characters`;
}

export function logDebug(
  chatId: string,
  kind: DebugEntry["kind"],
  label: string,
  payload?: unknown,
): void {
  let buffer = buffers.get(chatId);
  if (!buffer) {
    buffer = [];
    buffers.set(chatId, buffer);
  }
  const last = buffer[buffer.length - 1];
  if (last && last.kind === kind && last.label === label && Date.now() - last.at < COALESCE_MS) {
    // Replaced rather than bumped in place: the row is memoized on entry
    // identity, so an in-place `count` never reaches the screen. Same `seq`, so
    // React keys and the drawer's `expanded` set survive.
    buffer[buffer.length - 1] = { ...last, count: last.count + 1 };
  } else {
    buffer.push({ seq: seq++, at: Date.now(), kind, label, payload: snapshot(payload), count: 1 });
    if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
  version += 1;
  for (const listener of listeners) listener();
}

export function debugEntries(chatId: string): DebugEntry[] {
  return buffers.get(chatId) ?? [];
}

export function clearDebug(chatId: string): void {
  buffers.delete(chatId);
  version += 1;
  for (const listener of listeners) listener();
}

/* For useSyncExternalStore: the snapshot is a version counter, and consumers
   read the buffer directly — copying thousands of entries per event is what
   this avoids. */

export function subscribeDebug(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function debugVersion(): number {
  return version;
}

/* ---------- verbose CLI mode ---------- */
//
// `--debug-file` makes the CLI write its full debug firehose — API requests,
// MCP transports, retries — which the Rust side tails into `cli` entries.
// Costly and noisy, so opt-in, and it only applies when the process is
// (re)spawned.

const CLI_DEBUG_KEY = "mangouste.cliDebug";

export function cliDebugEnabled(): boolean {
  try {
    return localStorage.getItem(CLI_DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

export function setCliDebug(enabled: boolean): void {
  try {
    localStorage.setItem(CLI_DEBUG_KEY, enabled ? "1" : "0");
  } catch {
    // Private mode: the toggle just does not persist.
  }
}
