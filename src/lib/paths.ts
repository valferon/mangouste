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

/**
 * `path` made absolute against `base`, with `.` and `..` folded away.
 *
 * Claude writes repo-relative paths in its prose (`src/lib/ipc.ts`), and the
 * viewer reads from disk with no cwd of its own: handed the bare relative form
 * it asked for a path relative to wherever the app was launched. An absolute
 * path only has its dots folded. A `..` past the root stays at the root.
 *
 * A leading `~` is the home directory when `home` is known. Without it the `~`
 * is an ordinary segment, which opens nothing rather than the wrong file.
 */
export function resolvePath(base: string, path: string, home?: string | null): string {
  const expanded =
    home && (path === "~" || path.startsWith("~/")) ? `${home.replace(/\/+$/, "")}${path.slice(1)}` : path;
  const joined =
    expanded.startsWith("/") || !base ? expanded : `${base.replace(/\/+$/, "")}/${expanded}`;
  const kept: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") kept.pop();
    else kept.push(part);
  }
  return joined.startsWith("/") ? `/${kept.join("/")}` : kept.join("/");
}

/** Every directory strictly between `root` and `path`, outermost first. */
export function ancestorsWithin(root: string, path: string): string[] {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!path.startsWith(prefix)) return [];
  const dirs: string[] = [];
  let at = parentDir(path);
  while (at.length > root.replace(/\/+$/, "").length && at.startsWith(prefix)) {
    dirs.unshift(at);
    at = parentDir(at);
  }
  return dirs;
}

/**
 * Whether inline code reads as a file reference worth making clickable.
 *
 * At least two segments, so a bare `README.md` or a commit hash stays text.
 * Relative, absolute and `~/` forms all count, with an optional `:line`.
 * Anything with a space (`cat /x/y`) is a command, not a path.
 */
const PATH_LIKE = /^(?:~\/|\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+(?::\d+)?$/;

export function isPathLike(text: string): boolean {
  return PATH_LIKE.test(text);
}
