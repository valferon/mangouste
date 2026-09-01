import { gitRoot } from "./ipc";

/**
 * Repo roots, resolved once and remembered.
 *
 * Every path that can select a repo — a picker row, a session's raw cwd, a
 * quick-open hit — is normalised to its worktree root before the workbench
 * moves, because two names for one repo would tear down the chat you are using
 * and mint a second set of tabs for the same tree. That normalisation is a
 * `git rev-parse` in a child process behind an IPC hop, and it used to sit in
 * front of every switch: the click did nothing at all until it came back.
 *
 * A path's root does not change while the app runs, so the answer is worth
 * keeping. With the map warm — and it is warm for every discovered repo before
 * the first click — a switch is a `setState` on the same tick as the click.
 */
const roots = new Map<string, string>();

/** Resolutions in flight, so a path is never asked about twice at once. */
const pending = new Map<string, Promise<string>>();

/**
 * Note that `path` lives in the repo rooted at `root`.
 *
 * Called with a discovered repo as both arguments: a directory holding a `.git`
 * is its own toplevel, whether that `.git` is a directory, a worktree's file, or
 * a submodule's, so discovery already knows what `rev-parse` would say.
 */
export function rememberRepoRoot(path: string, root: string): void {
  roots.set(path, root);
  // The root resolves to itself, which is the lookup the strip and the restore
  // path actually make once a repo is active.
  roots.set(root, root);
}

/** The root for `path` if it is already known, else `null`. Never asks git. */
export function knownRepoRoot(path: string): string | null {
  return roots.get(path) ?? null;
}

/**
 * The root for `path`, asking git only when the answer is not already held.
 *
 * A path git cannot place — not a repo, or no git at all — resolves to itself
 * and is remembered as such: the workbench opens a plain directory happily, and
 * re-asking on every click would spawn a process per click to learn nothing.
 */
export async function repoRoot(path: string): Promise<string> {
  const known = roots.get(path);
  if (known !== undefined) return known;
  const already = pending.get(path);
  if (already) return already;
  const attempt = gitRoot(path)
    .catch(() => null)
    .then((found) => {
      const root = found ?? path;
      rememberRepoRoot(path, root);
      return root;
    })
    .finally(() => void pending.delete(path));
  pending.set(path, attempt);
  return attempt;
}

/**
 * Resolve these paths in the background, ignoring failures.
 *
 * Fed the sidebar's session directories as the scan reports them, so the root
 * for a session is known before the row is clicked rather than after. Paths
 * already held cost nothing, which is what makes it safe to call on a poll.
 */
export function warmRepoRoots(paths: Iterable<string>): void {
  for (const path of paths) {
    if (!path || roots.has(path) || pending.has(path)) continue;
    void repoRoot(path);
  }
}

/** Test-only: forget everything, so one case cannot prime the next. */
export function resetRepoRoots(): void {
  roots.clear();
  pending.clear();
}
