/**
 * Streamed thinking text, kept because nothing else keeps it.
 *
 * Every thinking block reaches this app twice: as `thinking_delta` events while
 * the model writes it, and as a settled `assistant` frame afterwards. Only the
 * first carries the text. The frame — and the transcript record written from it —
 * carries `thinking: ""` and a signature, which is why a resumed session shows a
 * rail of tool calls with the reasoning between them silently missing. Verified
 * against four transcripts in this project: 193 thinking blocks, none with text.
 *
 * So the text is kept here, keyed by the one stable name the block has, and
 * joined back on when history is hydrated. This is a cache and is allowed to
 * miss: a block written by another client, or evicted, renders as it does today.
 *
 * Bounded twice over. `MAX_ENTRIES` keeps the join cheap; `MAX_CHARS` is the one
 * that matters, because it caps what a single write has to serialise and keeps a
 * long-lived install from spending its whole storage quota on old reasoning.
 */
import { KEYS, readJson, writeJson } from "./persist";

const KEY = KEYS.cache.thinkingText;

/** Newest-last, so eviction is from the front. */
const MAX_ENTRIES = 500;

/** Total text kept, across every session. */
const MAX_CHARS = 256 * 1024;

/**
 * How much of a signature is used as the key.
 *
 * The tail rather than a hash: a signature is already a long opaque token, so 32
 * characters of it is a name no plausible number of entries collides on, and it
 * needs no hash function to stay stable across builds.
 */
const ID_CHARS = 32;

interface Entry {
  id: string;
  text: string;
}

/**
 * Read once per window, then maintained in memory.
 *
 * Both because the join runs per hydrated block — a 400-record transcript would
 * otherwise mean 400 parses of the whole store — and because writes need the
 * current list anyway to evict from it.
 */
let entries: Entry[] | null = null;
let index: Map<string, string> | null = null;

function load(): void {
  if (entries !== null && index !== null) return;
  const raw = readJson<unknown[]>(KEY, [], Array.isArray);
  const loaded: Entry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { id, text } = item as Record<string, unknown>;
    // A half-written entry is dropped rather than repaired: the cost is one
    // block rendering as it would have before this cache existed.
    if (typeof id === "string" && typeof text === "string" && id !== "" && text !== "") {
      loaded.push({ id, text });
    }
  }
  entries = loaded;
  index = new Map(loaded.map((entry) => [entry.id, entry.text]));
}

/**
 * The key for a signature, or null if it is too short to be one.
 *
 * A short or absent signature is not an error worth surfacing — it means this
 * block cannot be joined later, and the live render is unaffected either way.
 */
function keyFor(signature: string | undefined): string | null {
  if (typeof signature !== "string") return null;
  const trimmed = signature.trim();
  return trimmed.length >= ID_CHARS ? trimmed.slice(-ID_CHARS) : null;
}

/** Drop from the front until both bounds hold. */
function evict(list: Entry[]): Entry[] {
  let total = list.reduce((sum, entry) => sum + entry.text.length, 0);
  let start = 0;
  while (start < list.length && (list.length - start > MAX_ENTRIES || total > MAX_CHARS)) {
    total -= list[start].text.length;
    start += 1;
  }
  return start === 0 ? list : list.slice(start);
}

/**
 * Keep one block's text. Re-remembering the same block is a no-op.
 *
 * Called from the settled-frame path, where the text has just been spliced in,
 * so the caller already knows both halves.
 */
export function rememberThinking(signature: string | undefined, text: string): void {
  const id = keyFor(signature);
  if (id === null || text === "") return;
  load();
  const list = entries as Entry[];
  const map = index as Map<string, string>;
  if (map.get(id) === text) return;
  // A changed text for a known id means a longer read of the same block; the
  // later one is the complete one.
  const existing = list.findIndex((entry) => entry.id === id);
  if (existing !== -1) list.splice(existing, 1);
  list.push({ id, text });
  const kept = evict(list);
  if (kept !== list) {
    entries = kept;
    index = new Map(kept.map((entry) => [entry.id, entry.text]));
  } else {
    map.set(id, text);
  }
  writeJson(KEY, entries);
}

/** The text for a block whose frame arrived without any, if it was ever seen. */
export function recallThinking(signature: string | undefined): string | null {
  const id = keyFor(signature);
  if (id === null) return null;
  load();
  return (index as Map<string, string>).get(id) ?? null;
}

/** Drop everything. Exported for tests and a future "clear caches". */
export function forgetAllThinking(): void {
  entries = [];
  index = new Map();
  writeJson(KEY, []);
}
