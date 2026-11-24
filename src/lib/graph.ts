/**
 * Lane assignment for the history graph.
 *
 * `git log` already hands the frontend every commit's parents; what it does not
 * say is which *column* each commit belongs in, or which columns the lines
 * between two rows connect. That is this file: a single left-to-right pass over
 * the commit list, allocating a lane per line of development and freeing it
 * again when the line ends.
 *
 * Pure, and deliberately so — the pane renders whatever comes out, and the
 * awkward shapes (an octopus merge, a parent that is off the end of the loaded
 * page, two branches that converge) are cheap to write down as a list of
 * commits in a test.
 */

import type { Commit, LogFilter } from "./types";

/** Size of the colour palette the pane defines as `--graph-1 … --graph-8`. */
export const GRAPH_COLORS = 8;

/**
 * One line between two rows.
 *
 * A row is drawn in three bands: the top half, the node, the bottom half. An
 * edge that only passes by uses both halves (`pass`); one that ends at this
 * commit stops in the middle (`in`); one that leaves it starts there (`out`).
 * Splitting them this way is what lets a merge draw its second parent as a
 * curve out of the node rather than as a line through it.
 */
export interface GraphEdge {
  kind: "pass" | "in" | "out";
  /** Lane the segment starts in, at the top of the row. */
  from: number;
  /** Lane it ends in, at the bottom. */
  to: number;
  /** Palette index, `0 … GRAPH_COLORS - 1`. */
  color: number;
}

export interface GraphRow {
  sha: string;
  /** Column the commit's node sits in. */
  lane: number;
  color: number;
  edges: GraphEdge[];
  /** Lanes in use across this row, which is the column's width in lanes. */
  lanes: number;
}

/** Lowest free lane, or a new one on the end. */
function claimLane(lanes: (string | null)[], colors: number[]): number {
  const free = lanes.indexOf(null);
  if (free !== -1) return free;
  lanes.push(null);
  colors.push(0);
  return lanes.length - 1;
}

/**
 * A lane per line of development, and the edges between consecutive rows.
 *
 * `commits` must be in the order they are displayed in — `git log --date-order`
 * — and may be a page rather than the whole history: a parent that is not in
 * the list simply keeps its lane reserved to the bottom of the page, which is
 * what an unfinished line should look like.
 */
export function layoutGraph(commits: Commit[]): GraphRow[] {
  /** Per lane, the sha it is waiting to draw. */
  const lanes: (string | null)[] = [];
  /** Per lane, its palette index. Kept until the lane is reused. */
  const colors: number[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const before = lanes.slice();
    const beforeColors = colors.slice();

    // Every lane waiting for this sha converges here. The leftmost one holds
    // the node; the rest end at it and are freed.
    const waiting = before.reduce<number[]>(
      (found, sha, index) => (sha === commit.sha ? [...found, index] : found),
      [],
    );

    let lane: number;
    if (waiting.length > 0) {
      lane = waiting[0];
    } else {
      // Nothing was waiting: this is a branch tip (or the first row), so it
      // opens a line of its own and takes the next colour.
      lane = claimLane(lanes, colors);
      colors[lane] = nextColor % GRAPH_COLORS;
      nextColor += 1;
    }
    const color = colors[lane];
    for (const merged of waiting.slice(1)) lanes[merged] = null;

    // The first parent continues this line in the same lane and colour, which
    // is what makes a mainline read as one unbroken column.
    lanes[lane] = commit.parents[0] ?? null;
    const outs: GraphEdge[] = [];
    if (commit.parents.length > 0) {
      outs.push({ kind: "out", from: lane, to: lane, color });
    }
    for (const parent of commit.parents.slice(1)) {
      // A parent already awaited elsewhere is *that* lane's business: pointing
      // at it is how a merge closes back onto the branch it came from.
      let target = lanes.indexOf(parent);
      if (target === -1) {
        target = claimLane(lanes, colors);
        colors[target] = nextColor % GRAPH_COLORS;
        nextColor += 1;
        lanes[target] = parent;
      }
      outs.push({ kind: "out", from: lane, to: target, color: colors[target] });
    }

    const edges: GraphEdge[] = [];
    before.forEach((sha, index) => {
      if (sha === null) return;
      if (sha === commit.sha) {
        edges.push({ kind: "in", from: index, to: lane, color: beforeColors[index] });
      } else {
        edges.push({ kind: "pass", from: index, to: index, color: beforeColors[index] });
      }
    });
    edges.push(...outs);

    const width = Math.max(before.length, lanes.length, lane + 1);
    rows.push({ sha: commit.sha, lane, color, edges, lanes: width });

    // Trailing empties are not lanes. Without this a merge that closed the
    // rightmost column would leave every row below it padded by its width.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
      colors.pop();
    }
  }

  return rows;
}

/**
 * Whether a log filter leaves the commits it returns unconnected.
 *
 * A message, author or path filter drops commits out of the middle of the
 * history, and `git log` still prints each survivor's real parents, which are
 * mostly commits the filter left out. Laid out as a graph, every row then opens
 * a lane of its own for a parent that never arrives: a staircase of dangling
 * lines to the lane cap, on a list that has no lines to draw. A branch or a
 * range narrows the walk without holes in it, so those keep their graph.
 */
export function breaksAncestry(filter: Pick<LogFilter, "author" | "text" | "path">): boolean {
  return [filter.author, filter.text, filter.path].some((value) => (value ?? "").trim() !== "");
}

/**
 * One node per commit and no edges, for a list that is not a connected history.
 *
 * Same shape as `layoutGraph`'s rows, so the pane draws either the same way.
 */
export function layoutList(commits: Commit[]): GraphRow[] {
  return commits.map((commit) => ({ sha: commit.sha, lane: 0, color: 0, edges: [], lanes: 1 }));
}

