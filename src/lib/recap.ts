import { relativePath } from "./paths";
import type { SessionRecap } from "./types";

/**
 * How a recap reads in one line.
 *
 * Ordered by what actually settles "was this the session I mean": commits are
 * the strongest evidence a session did something, files next, then what it
 * delegated, and the number of asks last — a long conversation is not the same
 * as a productive one, so it is a tiebreaker and never the headline.
 *
 * Sections with nothing in them are left out rather than shown as zero. A row
 * saying `0 commits · 0 files` reads as a broken scan; the empty case has its
 * own sentence.
 */
export function recapHeadline(recap: SessionRecap): string {
  const plural = (count: number, one: string, many = `${one}s`) =>
    `${count} ${count === 1 ? one : many}`;
  const parts: string[] = [];
  if (recap.commitCount > 0) parts.push(plural(recap.commitCount, "commit"));
  if (recap.fileCount > 0) parts.push(plural(recap.fileCount, "file"));
  if (recap.agentCount > 0) parts.push(plural(recap.agentCount, "agent"));
  if (recap.prompts > 0) parts.push(plural(recap.prompts, "ask"));
  if (parts.length === 0) return "nothing but conversation";
  return parts.join(" · ");
}

/**
 * A file path as short as it can be and still be recognisable.
 *
 * Relative to the session's own cwd where it can be — that is how you think of
 * a file you edited in a repo — and an elided tail otherwise, because a session
 * that reached outside its repo (a dotfile, another checkout) is precisely the
 * case where the leading directories are the interesting part and still too
 * long for a sidebar row.
 */
export function recapFileLabel(path: string, cwd: string | null): string {
  const relative = cwd ? relativePath(cwd, path) : path;
  if (relative !== path) return relative;
  const segments = path.split("/").filter(Boolean);
  return segments.length <= 2 ? path : `…/${segments.slice(-2).join("/")}`;
}
