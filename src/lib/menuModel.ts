/**
 * The menu data model: what an entry is, and every pure operation over a list of
 * them. No React, no DOM, no clipboard.
 *
 * Split from `menu.tsx` so this half can be tested directly — the tidy/expand
 * rules and the cursor arithmetic are where the behaviour actually lives, and
 * they were previously reachable only by driving a popup. `menu.tsx` keeps the
 * provider, the keyboard handling and the rendering.
 */

/* ---------- entries ---------- */

export interface MenuAction {
  label: string;
  /** Right-aligned chord, from `CHORD`. Never a second source of truth. */
  accelerator?: string;
  /** Renders a tick column. `false` reserves the column but leaves it blank. */
  checked?: boolean;
  disabled?: boolean;
  /** Red label. For the irreversible ones only. */
  danger?: boolean;
  /** Nested menu. An entry with `items` ignores `run`. */
  items?: MenuEntry[];
  run?: () => unknown;
}

/**
 * Anything a menu can hold.
 *
 * `null`/`false`/`undefined`/`""` are allowed and dropped, so a conditional item
 * is `condition && { label: … }` rather than an array splice at the call site —
 * including when the condition is a path or an id, whose falsy value is `""`.
 */
export type MenuEntry =
  | MenuAction
  | "separator"
  | "editing"
  | "app"
  | { header: string }
  | null
  | false
  | undefined
  | "";

export function isAction(entry: MenuEntry): entry is MenuAction {
  return typeof entry === "object" && entry !== null && "label" in entry;
}

export function isHeader(entry: MenuEntry): entry is { header: string } {
  return typeof entry === "object" && entry !== null && "header" in entry;
}

/** The action at a raw position, or null when that slot is a rule or a header. */
export function itemAt(entries: MenuEntry[], index: number): MenuAction | null {
  const entry = entries[index];
  return isAction(entry) && !entry.disabled ? entry : null;
}

/* ---------- expansion ---------- */

/** What the two sentinels stand for, supplied by the caller. */
export interface Expanders {
  /** `"editing"` — needs the DOM, so it is injected rather than imported. */
  editing: () => MenuEntry[];
  /** `"app"` — the workbench-wide block. */
  app: () => MenuEntry[];
}

export function expand(entries: MenuEntry[], expanders: Expanders): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    if (entry === "editing") {
      out.push(...expanders.editing());
    } else if (entry === "app") {
      out.push(...expanders.app());
    } else if (isAction(entry) && entry.items) {
      out.push({ ...entry, items: expand(entry.items, expanders) });
    } else {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Drop the falsy entries, then the rules that no longer separate anything.
 *
 * A block that collapsed to nothing — no selection, no session id, no upstream —
 * must not leave a horizontal rule behind to mark where it would have been.
 */
export function tidy(entries: MenuEntry[]): MenuEntry[] {
  const kept: MenuEntry[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "separator") {
      if (kept.length > 0 && kept[kept.length - 1] !== "separator") kept.push(entry);
      continue;
    }
    if (isAction(entry) && entry.items) {
      const items = tidy(entry.items);
      // A submenu with nothing in it is not a menu; drop the parent with it.
      if (items.length > 0) kept.push({ ...entry, items });
      continue;
    }
    kept.push(entry);
  }
  while (kept.length > 0 && kept[kept.length - 1] === "separator") kept.pop();
  return kept;
}

/* ---------- navigation ---------- */

/** The entries visible at `level`, walking `path` down through the submenus. */
export function entriesAtLevel(root: MenuEntry[], path: number[], level: number): MenuEntry[] {
  let list = root;
  for (let depth = 0; depth < level; depth += 1) {
    const item = itemAt(list, path[depth]);
    list = item?.items ?? [];
  }
  return list;
}

/** Next selectable position from `from`, wrapping. -1 when there is none. */
export function step(entries: MenuEntry[], from: number, direction: 1 | -1): number {
  const total = entries.length;
  if (total === 0) return -1;
  for (let taken = 1; taken <= total; taken += 1) {
    const at = (((from + direction * taken) % total) + total) % total;
    if (itemAt(entries, at)) return at;
  }
  return -1;
}

