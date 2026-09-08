import { flushSync } from "react-dom";

/**
 * Open expensive rows a few per frame instead of all in one commit.
 *
 * Flipping the dial to `verbose` asks every tool row in the transcript to mount
 * its arguments and output at once: a few hundred highlighted `<pre>`s, some of
 * them thousands of lines, in a single synchronous render followed by a single
 * layout. That is the hang. The work is not avoidable — the user asked to see
 * all of it — but nothing says it has to land in one frame.
 *
 * So rows queue up here and the queue drains inside animation frames, each
 * frame spending at most `budgetMs` of React time before yielding. Every row is
 * flushed on its own so the clock actually measures it; a batched `setState`
 * would render after the callback returned, where it cannot be timed.
 *
 * Newest first, because the newest rows are the ones on screen: the tail of the
 * transcript opens on the first frame and history fills in above it, out of
 * view, over the next second or so. A row that arrives live while a backlog is
 * still draining goes to the front for the same reason.
 */
export interface Revealer {
  /** Queue `open` to run in a coming frame. Returns a cancel for unmount. */
  add(open: () => void): () => void;
  /** True while nothing is queued and no frame is scheduled. */
  idle(): boolean;
}

export interface RevealerDeps {
  /** React time to spend per frame before yielding to the browser. */
  budgetMs: number;
  /** `requestAnimationFrame`, or a fake in tests. */
  frame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  now: () => number;
  /** Runs one row's open synchronously so it can be timed: `flushSync`. */
  flush: (work: () => void) => void;
}

export function createRevealer(deps: RevealerDeps): Revealer {
  const queue: Array<() => void> = [];
  let scheduled: number | null = null;

  const pump = () => {
    scheduled = null;
    const started = deps.now();
    // At least one per frame, however slow the last one was, or a single row
    // over budget would stall the queue for good.
    do {
      const open = queue.pop();
      if (open === undefined) break;
      deps.flush(open);
    } while (queue.length > 0 && deps.now() - started < deps.budgetMs);
    if (queue.length > 0) scheduled = deps.frame(pump);
  };

  return {
    add(open) {
      queue.push(open);
      if (scheduled === null) scheduled = deps.frame(pump);
      return () => {
        const index = queue.lastIndexOf(open);
        if (index !== -1) queue.splice(index, 1);
        if (queue.length === 0 && scheduled !== null) {
          deps.cancelFrame(scheduled);
          scheduled = null;
        }
      };
    },
    idle: () => queue.length === 0 && scheduled === null,
  };
}

/**
 * The one the transcript uses.
 *
 * Shared across panes on purpose: it is a throttle on main-thread work, and
 * two tabs opening their histories at once are competing for the same thread.
 *
 * 6ms of React per frame leaves room for the layout that follows the commit,
 * which the clock here cannot see and which is roughly proportional.
 */
export const revealer: Revealer = createRevealer({
  budgetMs: 6,
  frame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (handle) => window.cancelAnimationFrame(handle),
  now: () => performance.now(),
  flush: flushSync,
});
