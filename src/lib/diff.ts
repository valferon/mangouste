/**
 * What a unified-diff line is, decided by its first characters.
 *
 * Shared by the colouriser (`diffLineClass`) and the syntax highlighter
 * (`diffSide`) so the two never disagree about which lines are content: a line
 * painted as an addition is highlighted as post-image code, and a header is
 * neither.
 */

/** CSS class for a diff line. */
export function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-meta";
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "diff-meta";
  return "";
}

/**
 * Which side of the change a line's text belongs to.
 *
 * `both` is a context line, `none` is anything that is not file content — hunk
 * and file headers, `index` lines, `\ No newline at end of file`, and the
 * preamble of a `git show`. Only `old`/`new`/`both` lines carry a one-character
 * prefix that the caller strips.
 */
export type DiffSide = "old" | "new" | "both" | "none";

export function diffSide(line: string): DiffSide {
  const first = line[0];
  if (first === " ") return "both";
  if (first === "+") return line.startsWith("+++") ? "none" : "new";
  if (first === "-") return line.startsWith("---") ? "none" : "old";
  return "none";
}

/** Path a `diff --git a/x b/y` header is about, preferring the post-image. */
export function diffHeaderPath(header: string): string | null {
  const match = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!match) return null;
  const [, before, after] = match;
  return after === "dev/null" ? before : after;
}

/**
 * Path named by a `+++`/`---` file header, or null.
 *
 * Accepts the `a/`/`b/` prefixes git adds and the tab-separated timestamp
 * `diff -u` appends; `/dev/null` (one side of a create or delete) is not a path.
 */
export function diffFileHeaderPath(line: string): string | null {
  const match = line.match(/^(?:\+\+\+|---) (?:[ab]\/)?([^\t]+)/);
  if (!match || match[1] === "/dev/null") return null;
  return match[1];
}
