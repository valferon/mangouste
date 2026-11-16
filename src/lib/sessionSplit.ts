/**
 * Two tabs side by side in the centre pane: two sessions, or a session and a
 * file.
 *
 * The split is a pair of tab ids, not a second strip: both tabs stay in their
 * own rows, and the pair is on screen whenever either of them is the tab in
 * front. Picking some other tab from the strip while the pair is up swaps it in
 * on the side holding the same kind of tab, the way an editor group takes the
 * file you open into it: a session replaces a session, a file replaces a file.
 * When both sides are that kind, the side that had focus takes it. A tab with
 * no side of its kind (a file picked while two sessions are up, any view) is
 * shown on its own and leaves the pair alone, so coming back to either side
 * brings both back.
 *
 * Pure, so the rules can be tested without the workbench around them.
 */

/** What a side of the pair can hold. */
export type SplitKind = "chat" | "file";

/**
 * The kind of a tab the pair could show right now, or null for one it cannot:
 * a view, a tab from another repo, a tab that is gone.
 */
export type SplitKindOf = (id: string) => SplitKind | null;

export interface SessionSplit {
  left: string;
  right: string;
  /** The left pane's share of the width, 0 to 1. */
  share: number;
}

/** Narrowest either side can be dragged down to. */
export const MIN_SPLIT_SHARE = 0.2;

export function makeSplit(left: string, right: string): SessionSplit {
  return { left, right, share: 0.5 };
}

export function inSplit(split: SessionSplit | null, id: string): boolean {
  return split !== null && (split.left === id || split.right === id);
}

/**
 * Is the pair on screen? Only with one of its own tabs in front, and only
 * while both can still be shown: a session tab, in the repo the strip is on.
 */
export function splitShown(
  split: SessionSplit | null,
  active: string,
  showable: (id: string) => boolean,
): split is SessionSplit {
  return (
    split !== null &&
    inSplit(split, active) &&
    split.left !== split.right &&
    showable(split.left) &&
    showable(split.right)
  );
}

/**
 * Follow the tab in front moving from `from` to `to`.
 *
 * A move from one side of a showing pair to a tab outside it puts that tab on
 * the side holding its own kind, or on `from`'s side when both do. Anything
 * else leaves the pair as it is.
 */
export function followActive(
  split: SessionSplit | null,
  from: string,
  to: string,
  kindOf: SplitKindOf,
): SessionSplit | null {
  if (!splitShown(split, from, (id) => kindOf(id) !== null)) return split;
  if (inSplit(split, to)) return split;
  const kind = kindOf(to);
  if (kind === null) return split;
  const leftFits = kindOf(split.left) === kind;
  const rightFits = kindOf(split.right) === kind;
  if (!leftFits && !rightFits) return split;
  const intoLeft = leftFits && rightFits ? split.left === from : leftFits;
  return intoLeft ? { ...split, left: to } : { ...split, right: to };
}

/**
 * The pair for "Open to the Side" of `tab` beside `partner`, the tab that was
 * in front before it.
 *
 * A session always keeps the left: reading code beside the session that is
 * writing it is the layout you asked for, whichever of the two you started
 * from. Two tabs of one kind keep the order they were opened in.
 */
export function pairBeside(partner: string, tab: string, kindOf: SplitKindOf): SessionSplit {
  return kindOf(partner) === "file" && kindOf(tab) === "chat"
    ? makeSplit(tab, partner)
    : makeSplit(partner, tab);
}

/** Drop the pair once either of its tabs has been closed. */
export function pruneSplit(
  split: SessionSplit | null,
  exists: (id: string) => boolean,
): SessionSplit | null {
  if (split === null) return null;
  return exists(split.left) && exists(split.right) ? split : null;
}

/** Move the divider by `delta`, a fraction of the centre pane's width. */
export function resizeSplitShare(split: SessionSplit, delta: number): SessionSplit {
  const share = Math.min(Math.max(split.share + delta, MIN_SPLIT_SHARE), 1 - MIN_SPLIT_SHARE);
  return share === split.share ? split : { ...split, share };
}
