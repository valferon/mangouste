/** Path arithmetic. Posix-only, which is what the Rust side hands back. */

/** Last segment of a path, or the path itself when there is only one. */
export function baseName(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? path : path.slice(at + 1) || path;
}

/** Everything above the last segment, or "" for a bare name. */
export function parentDir(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "" : path.slice(0, at);
}

/**
 * `path` as written from inside `root`.
 *
 * Falls back to the absolute path when it is not under `root` at all — a file
 * opened from another repo has no relative name worth showing.
 */
export function relativePath(root: string, path: string): string {
  if (!root) return path;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
