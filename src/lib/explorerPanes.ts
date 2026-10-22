/**
 * The explorer as a vertical stack of trees, each rooted wherever it was pointed.
 *
 * A pane with a `null` root follows the active repo, which is what the explorer
 * always was. Pointing one somewhere else — a parent folder, a sibling checkout,
 * `~/.claude` — gives it a fixed root that survives repo switches, because the
 * reason to keep a second tree open is that it is *not* the repo.
 *
 * Everything here is pure so the stack's bookkeeping can be tested without a
 * DOM; the component only renders it.
 */

import { isRecord } from "./persist";

export interface ExplorerPane {
  id: string;
  /** Absolute directory, or `null` to follow the active repo. */
  root: string | null;
  /** Flex weight inside the stack, so the dividers can be dragged. */
  weight: number;
}

/** One clickable segment of a root's path. */
export interface Crumb {
  label: string;
  path: string;
}

/** Smallest share of the stack's height a pane can be dragged down to. */
export const MIN_SHARE = 0.08;

/** The directory a pane is showing right now. */
export function paneRoot(pane: ExplorerPane, repo: string): string {
  return pane.root ?? repo;
}

/**
 * A root's path as clickable segments, abbreviating the home directory to `~`.
 *
 * The home prefix collapses into one crumb because it is the part nobody reads:
 * `/home/val/workspace/x` is four segments of which the first two say nothing.
 */
export function breadcrumbs(path: string, home: string | null): Crumb[] {
  const clean = trimSlash(path);
  if (clean === "") return [{ label: "/", path: "/" }];
  const homeClean = home ? trimSlash(home) : "";
  if (homeClean && (clean === homeClean || clean.startsWith(`${homeClean}/`))) {
    const rest = clean.slice(homeClean.length).split("/").filter(Boolean);
    return [{ label: "~", path: homeClean }, ...segments(homeClean, rest)];
  }
  const parts = clean.split("/").filter(Boolean);
  return [{ label: "/", path: "/" }, ...segments("", parts)];
}

function segments(base: string, parts: string[]): Crumb[] {
  let at = base;
  return parts.map((part) => {
    at = `${at}/${part}`;
    return { label: part, path: at };
  });
}

/** `path` without trailing slashes, keeping `/` itself as the empty string. */
function trimSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

/**
 * Turn what was typed into the path bar into an absolute directory.
 *
 * `~` expands; a relative path resolves against the pane's current root, the
 * way a shell would against its cwd. `..` and `.` collapse so the crumbs show
 * where the tree actually is. Returns null for something that is not a path.
 */
export function resolveTyped(input: string, base: string, home: string | null): string | null {
  const typed = input.trim();
  if (typed === "") return null;
  let absolute: string;
  if (typed === "~" || typed.startsWith("~/")) {
    if (!home) return null;
    absolute = `${trimSlash(home)}${typed.slice(1)}`;
  } else if (typed.startsWith("/")) {
    absolute = typed;
  } else {
    absolute = `${trimSlash(base)}/${typed}`;
  }
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** The directory above `path`, or null at the filesystem root. */
export function parentOf(path: string): string | null {
  const clean = trimSlash(path);
  if (clean === "") return null;
  const at = clean.lastIndexOf("/");
  return at <= 0 ? "/" : clean.slice(0, at);
}

/**
 * Point a pane at `root`.
 *
 * Pointing it back at the repo turns it into a follower again rather than
 * pinning it to this one repo, so "⌂" and clicking the repo's own crumb mean
 * the same thing.
 */
export function rerootPane(
  panes: ExplorerPane[],
  id: string,
  root: string,
  repo: string,
): ExplorerPane[] {
  const next = root === repo ? null : root;
  return panes.map((pane) => (pane.id === id && pane.root !== next ? { ...pane, root: next } : pane));
}

/**
 * Add a pane below `id`, showing `root` — or the same directory, when unset.
 *
 * The new pane takes half of the one it splits rather than an equal share of
 * the whole stack, so splitting a small pane does not squash every other one.
 */
export function splitPane(
  panes: ExplorerPane[],
  id: string,
  newId: string,
  root?: string | null,
): ExplorerPane[] {
  const at = panes.findIndex((pane) => pane.id === id);
  const source = at < 0 ? panes[panes.length - 1] : panes[at];
  if (!source) return [{ id: newId, root: root ?? null, weight: 1 }];
  const half = source.weight / 2;
  const added: ExplorerPane = { id: newId, root: root === undefined ? source.root : root, weight: half };
  const index = at < 0 ? panes.length : at + 1;
  const resized = panes.map((pane) => (pane.id === source.id ? { ...pane, weight: half } : pane));
  return [...resized.slice(0, index), added, ...resized.slice(index)];
}

/**
 * Drop a pane. The last one stays: an explorer with no tree is not a state.
 *
 * Its weight goes to the pane that grew into its space — the one above, or
 * below for the top pane — so the others keep their size. Dropped instead, the
 * weights left behind can sum below 1, and a `flex-grow` total under 1 only
 * hands out that fraction of the free space: close a split and the survivor
 * stayed at half height.
 */
export function closePane(panes: ExplorerPane[], id: string): ExplorerPane[] {
  if (panes.length <= 1) return panes;
  const at = panes.findIndex((pane) => pane.id === id);
  if (at < 0) return panes;
  const heir = at > 0 ? at - 1 : 1;
  const freed = panes[at].weight;
  return panes
    .map((pane, index) => (index === heir ? { ...pane, weight: pane.weight + freed } : pane))
    .filter((_, index) => index !== at);
}

/**
 * Each pane's `flex-grow`, as a share of the whole stack.
 *
 * Normalised so the grows always sum to 1, whatever the stored weights add up
 * to: a stack written by an older build, or rounded by a drag, still fills the
 * explorer top to bottom.
 */
export function growShares(panes: ExplorerPane[]): number[] {
  const total = panes.reduce((sum, pane) => sum + pane.weight, 0);
  return panes.map((pane) => (total > 0 ? pane.weight / total : 1 / panes.length));
}

/**
 * Turn a divider drag into a weight change for the pair it sits between.
 *
 * `index` is the pane below the divider. Same arithmetic as the terminal's
 * side-by-side splits, turned on its side.
 */
export function resizePanes(
  panes: ExplorerPane[],
  index: number,
  delta: number,
  height: number,
): ExplorerPane[] {
  const above = panes[index - 1];
  const below = panes[index];
  if (!above || !below || height <= 0) return panes;
  const total = panes.reduce((sum, pane) => sum + pane.weight, 0);
  const pair = above.weight + below.weight;
  const min = MIN_SHARE * total;
  if (pair < min * 2) return panes;
  const wanted = above.weight + (delta / height) * total;
  const nextAbove = Math.min(Math.max(wanted, min), pair - min);
  return panes.map((pane, at) => {
    if (at === index - 1) return { ...pane, weight: nextAbove };
    if (at === index) return { ...pane, weight: pair - nextAbove };
    return pane;
  });
}

/**
 * A repo switch puts the first pane back on the repo.
 *
 * The top tree is "the explorer" — picking a repo and seeing the tree not
 * change reads as the switch having failed. The panes below were opened on
 * purpose somewhere else, and keep their roots.
 */
export function followRepoSwitch(panes: ExplorerPane[]): ExplorerPane[] {
  const [first, ...rest] = panes;
  if (!first || first.root === null) return panes;
  return [{ ...first, root: null }, ...rest];
}

/**
 * Validator for the stored stack. Anything else falls back to one pane.
 *
 * Ids must be unique, since they key both the React rows and the watch set.
 * Roots must already be in the shape the stack writes — absolute, no `..`, no
 * trailing slash — because every "is this under the root" check compares
 * strings, and `/a/` or `/a/../b` would own nothing.
 */
export function isPaneList(value: unknown): value is ExplorerPane[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value.map((pane) => (isRecord(pane) ? pane.id : undefined))).size === value.length &&
    value.every(
      (pane) =>
        isRecord(pane) &&
        typeof pane.id === "string" &&
        (pane.root === null ||
          (typeof pane.root === "string" && resolveTyped(pane.root, "/", null) === pane.root)) &&
        typeof pane.weight === "number" &&
        Number.isFinite(pane.weight) &&
        pane.weight > 0,
    )
  );
}
