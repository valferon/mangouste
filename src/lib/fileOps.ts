/**
 * Path arithmetic and validation for the explorer's mutating actions.
 *
 * Kept out of `FileTree.tsx` because every rule here is a rule about what the
 * *backend* will refuse, and those are worth asserting without mounting a tree:
 * the component's job is the input row and the menu, not deciding whether
 * `../etc` is a legal folder name.
 */

import { baseName, parentDir } from "./paths";

/** What the tree is asking the user to type. */
export type DraftKind = "file" | "folder" | "rename";

/** Longest single path segment ext4, APFS and NTFS all accept. */
const MAX_SEGMENT = 255;

/**
 * Why a typed name cannot be used, or `null` when it can.
 *
 * Returns a message rather than a boolean: an input row that goes red without
 * saying which of these rules was broken makes the user guess, and "Downloads/"
 * being rejected for its trailing slash is not guessable.
 */
export function nameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name cannot be empty";
  if (trimmed.startsWith("/")) return "Name cannot start with /";
  if (trimmed.endsWith("/")) return "Name cannot end with /";
  if (trimmed.includes("\0")) return "Name cannot contain a null byte";

  for (const segment of trimmed.split("/")) {
    if (!segment) return "Name cannot contain an empty path segment";
    // `.` and `..` would resolve outside the directory the row sits in — the
    // one case where a plausible-looking name silently targets somewhere else.
    if (segment === "." || segment === "..") return "Name cannot contain . or ..";
    if (segment.length > MAX_SEGMENT) return "Name is too long";
  }
  return null;
}

/**
 * Absolute path for a name typed into `dir`.
 *
 * Nested input is deliberate, not tolerated: `api/routes/users.ts` in one go is
 * how a new file in a new directory gets made without three round trips
 * through "New Folder". The backend creates the parents.
 */
export function draftPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name.trim().replace(/\/+$/, "")}`;
}

/** Whether `path` is `dir` itself or sits anywhere beneath it. */
export function isUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * The directory a drop on `target` lands in.
 *
 * A drop on a directory goes *into* it; a drop on a file goes beside it, which
 * is the same thing every file manager does and spares the user having to hit
 * the parent folder's own row to mean "here".
 */
export function dropTarget(targetPath: string, targetIsDir: boolean): string {
  return targetIsDir ? targetPath : parentDir(targetPath);
}

/**
 * Where `from` would land in `dir`, or why it cannot go there.
 *
 * The three refusals are the ones a drag can produce by accident, and each
 * would otherwise turn into a backend error the user has to read: dropping a
 * row back where it already was, dropping a directory onto itself, and
 * dropping it onto one of its own descendants (which would move a tree inside
 * itself and, on the cross-filesystem copy path, never terminate).
 */
export function moveTarget(from: string, dir: string): { path: string } | { error: string } {
  if (!dir) return { error: "No destination" };
  if (parentDir(from) === dir) return { error: "Already there" };
  if (isUnder(dir, from)) return { error: "Cannot move a folder into itself" };
  return { path: `${dir}/${baseName(from)}` };
}

/**
 * What a path becomes after `from` was renamed to `to`, or `null` if untouched.
 *
 * Descendants move with their directory, which is what makes this more than a
 * string compare: renaming `src` has to carry every open tab under it, or the
 * editor keeps buffers pointed at paths that no longer resolve.
 */
export function repointPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  return null;
}

/**
 * The confirm text in front of a delete.
 *
 * Says "permanently" because it is: this app has no trash and no undo, so the
 * dialog is the only place the user finds that out.
 */
export function deleteWarning(path: string, isDir: boolean): string {
  const what = isDir ? "folder" : "file";
  const extra = isDir ? " and everything in it" : "";
  return `Permanently delete the ${what} “${baseName(path)}”${extra}? This cannot be undone.`;
}

/**
 * Every directory between `dir` and a path created under it, `dir` included.
 *
 * What makes a nested create ("api/routes/users.ts") visible: the file lands
 * two levels below the row the name was typed on, and without expanding the
 * directories the backend just made, the tree shows nothing happened.
 */
export function ancestorsBetween(dir: string, path: string): string[] {
  if (!isUnder(path, dir)) return [];
  const chain = [dir];
  const rest = path.slice(dir.length + 1).split("/");
  // The last segment is the entry itself, which is not a directory to open.
  for (const segment of rest.slice(0, -1)) {
    chain.push(`${chain[chain.length - 1]}/${segment}`);
  }
  return chain;
}

/** Placeholder for the input row, per action. */
export function draftPrompt(kind: DraftKind): string {
  if (kind === "file") return "New file name";
  if (kind === "folder") return "New folder name";
  return "New name";
}

/**
 * The directories a refresh has to re-read, shallowest first.
 *
 * `root` always, then every directory already listed under it. Re-reading only
 * the root is the bug this exists to name: the top level's own names do not
 * change when a pull rewrites `src/lib/ipc.ts`, so Refresh returned the same
 * tree and looked broken.
 *
 * Cache keys from other repos are dropped — the tree keeps them across a repo
 * switch — and so is any key that is not `root` or beneath it.
 */
export function refreshTargets(root: string, cached: string[]): string[] {
  const under = cached.filter((dir) => dir !== root && isUnder(dir, root));
  // Parents before children: a directory the pull deleted is dropped from the
  // cache by its own failed listing, and doing the shallow ones first means the
  // parent that no longer lists it has already said so.
  under.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return [root, ...under];
}
