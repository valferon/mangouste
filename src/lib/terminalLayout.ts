/**
 * A terminal tab's panes as a split tree: side by side, stacked, or any nesting
 * of the two.
 *
 * The tree is only ever *read* as a list of rectangles. Rendering it as nested
 * flex boxes would be the obvious thing and the wrong one: splitting a pane
 * wraps it in a new box, React sees a pane under a different parent, unmounts
 * it, and `TerminalPane`'s cleanup kills the shell. So every pane stays a direct
 * child of the tab body and is placed by `layoutTree` instead.
 *
 * Pure, so the bookkeeping can be tested without a DOM.
 */

/** `row` puts children side by side; `column` stacks them. */
export type SplitDirection = "row" | "column";

export interface PaneLeaf {
  kind: "pane";
  /** The key the Rust side stores the pty under. */
  id: string;
  /** Flex weight among its siblings, so a divider can be dragged. */
  weight: number;
}

export interface PaneSplit {
  kind: "split";
  id: string;
  dir: SplitDirection;
  weight: number;
  /** Always two or more; a split left holding one child is collapsed away. */
  children: PaneNode[];
}

export type PaneNode = PaneLeaf | PaneSplit;

/** A box as fractions of the tab body, 0 to 1 on each axis. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaneRect extends Rect {
  id: string;
}

/** The boundary before `split.children[index]`, which is what a drag moves. */
export interface DividerRect extends Rect {
  split: string;
  index: number;
  dir: SplitDirection;
  /** The split's own extent along `dir`, as a fraction of the body's. */
  extent: number;
}

export interface TreeLayout {
  panes: PaneRect[];
  dividers: DividerRect[];
}

/** Smallest share of a split a pane can be dragged down to. */
export const MIN_SHARE = 0.08;

export function leaf(id: string, weight = 1): PaneLeaf {
  return { kind: "pane", id, weight };
}

/** Every pane id, in reading order. */
export function paneIds(node: PaneNode): string[] {
  return node.kind === "pane" ? [node.id] : node.children.flatMap(paneIds);
}

export function hasPane(node: PaneNode, id: string): boolean {
  return node.kind === "pane" ? node.id === id : node.children.some((child) => hasPane(child, id));
}

/**
 * Put `fresh` beside `target`, after it, along `dir`.
 *
 * Inside a split that already runs along `dir` the new pane joins it as a
 * sibling and takes half of the target's share, so splitting the right pane of
 * a pair does not squeeze the left one. Anywhere else the target is wrapped in
 * a new split of its own. An unknown target leaves the tree as it was.
 */
export function splitPane(
  root: PaneNode,
  target: string,
  fresh: string,
  dir: SplitDirection,
): PaneNode {
  if (root.kind === "pane") {
    if (root.id !== target) return root;
    return wrap(root, fresh, dir, `${fresh}:split`);
  }
  const at = root.children.findIndex((child) => child.kind === "pane" && child.id === target);
  if (at >= 0 && root.dir === dir) {
    const old = root.children[at];
    const half = old.weight / 2;
    const children = [
      ...root.children.slice(0, at),
      { ...old, weight: half },
      leaf(fresh, half),
      ...root.children.slice(at + 1),
    ];
    return { ...root, children };
  }
  if (at >= 0) {
    const children = root.children.map((child, index) =>
      index === at ? wrap(child as PaneLeaf, fresh, dir, `${fresh}:split`) : child,
    );
    return { ...root, children };
  }
  let changed = false;
  const children = root.children.map((child) => {
    if (changed || child.kind === "pane" || !hasPane(child, target)) return child;
    changed = true;
    return splitPane(child, target, fresh, dir);
  });
  return changed ? { ...root, children } : root;
}

function wrap(pane: PaneLeaf, fresh: string, dir: SplitDirection, id: string): PaneSplit {
  return {
    kind: "split",
    id,
    dir,
    weight: pane.weight,
    children: [{ ...pane, weight: 1 }, leaf(fresh, 1)],
  };
}

/**
 * Drop the pane `id`. Null when it was the last one.
 *
 * A split left with one child is replaced by that child, which keeps the
 * split's weight; and a child that is itself a split along its new parent's
 * axis is merged into it, so closing panes never leaves nesting behind that
 * the user could not have built by splitting.
 */
export function removePane(root: PaneNode, id: string): PaneNode | null {
  if (root.kind === "pane") return root.id === id ? null : root;
  if (!hasPane(root, id)) return root;
  const children = root.children
    .map((child) => removePane(child, id))
    .filter((child): child is PaneNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return { ...children[0], weight: root.weight };
  return { ...root, children: flatten(root.dir, children) };
}

/** Inline any child split that runs the same way as its parent. */
function flatten(dir: SplitDirection, children: PaneNode[]): PaneNode[] {
  return children.flatMap((child) => {
    if (child.kind === "pane" || child.dir !== dir) return [child];
    const total = sum(child.children);
    return child.children.map((inner) => ({
      ...inner,
      weight: (inner.weight / total) * child.weight,
    }));
  });
}

/**
 * Move the divider before `split.children[index]` by `delta`, a fraction of
 * that split's own extent. Clamped so neither neighbour goes under
 * `MIN_SHARE` of the split.
 */
export function resizeSplit(
  root: PaneNode,
  splitId: string,
  index: number,
  delta: number,
): PaneNode {
  if (root.kind === "pane") return root;
  if (root.id !== splitId) {
    let changed = false;
    const children = root.children.map((child) => {
      const next = resizeSplit(child, splitId, index, delta);
      if (next !== child) changed = true;
      return next;
    });
    return changed ? { ...root, children } : root;
  }
  const before = root.children[index - 1];
  const after = root.children[index];
  if (!before || !after) return root;
  const total = sum(root.children);
  const pair = before.weight + after.weight;
  const min = MIN_SHARE * total;
  // Two minimums do not fit in the pair, so there is nothing to give.
  if (pair < min * 2) return root;
  const wanted = before.weight + delta * total;
  const nextBefore = Math.min(Math.max(wanted, min), pair - min);
  const children = root.children.map((child, at) => {
    if (at === index - 1) return { ...child, weight: nextBefore };
    if (at === index) return { ...child, weight: pair - nextBefore };
    return child;
  });
  return { ...root, children };
}

/** Every pane and divider as a box inside the unit square. */
export function layoutTree(root: PaneNode): TreeLayout {
  const out: TreeLayout = { panes: [], dividers: [] };
  place(root, { x: 0, y: 0, w: 1, h: 1 }, out);
  return out;
}

function place(node: PaneNode, box: Rect, out: TreeLayout): void {
  if (node.kind === "pane") {
    out.panes.push({ id: node.id, ...box });
    return;
  }
  const total = sum(node.children);
  const row = node.dir === "row";
  const extent = row ? box.w : box.h;
  let offset = 0;
  node.children.forEach((child, index) => {
    const share = (child.weight / total) * extent;
    const start = (row ? box.x : box.y) + offset;
    if (index > 0) {
      out.dividers.push(
        row
          ? { split: node.id, index, dir: node.dir, extent, x: start, y: box.y, w: 0, h: box.h }
          : { split: node.id, index, dir: node.dir, extent, x: box.x, y: start, w: box.w, h: 0 },
      );
    }
    place(
      child,
      row ? { ...box, x: start, w: share } : { ...box, y: start, h: share },
      out,
    );
    offset += share;
  });
}

function sum(nodes: PaneNode[]): number {
  return nodes.reduce((total, node) => total + node.weight, 0);
}
