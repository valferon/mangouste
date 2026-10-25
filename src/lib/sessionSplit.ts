/**
 * Two sessions side by side in the centre pane.
 *
 * The split is a pair of tab ids, not a second strip: both tabs stay in the one
 * session row, and the pair is on screen whenever either of them is the tab in
 * front. Picking some other session from the strip while the pair is up swaps
 * it in on the side that had focus, the way an editor group takes the file you
 * open into it. Picking a file or a view leaves the pair alone, so coming back
 * to either session brings both back.
 *
 * Pure, so the rules can be tested without the workbench around them.
 */

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
 * A move from one side of a showing pair to a session outside it puts that
 * session where `from` was. Anything else leaves the pair as it is.
 */
export function followActive(
  split: SessionSplit | null,
  from: string,
  to: string,
  showable: (id: string) => boolean,
): SessionSplit | null {
  if (!splitShown(split, from, showable)) return split;
  if (inSplit(split, to) || !showable(to)) return split;
  return split.left === from ? { ...split, left: to } : { ...split, right: to };
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
