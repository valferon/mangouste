/**
 * How much of an edit's diff belongs in the conversation itself.
 *
 * The chat can render a whole diff — it does, inside a tool card you opened, and
 * in the permission prompt where a decision depends on reading all of it. In the
 * flow the constraint is different: the diff is there so you can see what the
 * session is doing *without* stopping to read, and a four-hundred-line `Write`
 * pasted between two paragraphs is not a glance, it is a wall.
 *
 * So the preview keeps the changed lines and drops context first. A diff is
 * mostly context by volume — unchanged lines carried along to place the change —
 * and context is exactly the part you do not need when the question is "what is
 * it changing". What is left is `+`/`-` lines and the hunk headers that say
 * where they are, which is the shape of the change at a glance.
 */

/** A `@@ … @@` header, or one of the synthetic ones `toolDiffLines` writes. */
const isHeader = (line: string): boolean => line.startsWith("@@");

/** A line the edit actually changes, as opposed to context carried with it. */
const isChange = (line: string): boolean => line.startsWith("+") || line.startsWith("-");

export interface DiffPreview {
  lines: string[];
  /** Lines the preview left out, for the affordance that opens the full card. */
  hidden: number;
}

/**
 * The first `max` lines worth showing of a synthesised edit diff.
 *
 * Two passes rather than a slice: a diff whose first twenty lines are context
 * would preview as twenty lines that say nothing changed. Changes and headers
 * are kept in their original order, and context fills whatever room is left —
 * so a small edit still previews exactly as it was written, context and all.
 */
export function previewDiff(lines: readonly string[], max: number): DiffPreview {
  if (max <= 0) return { lines: [], hidden: lines.length };
  if (lines.length <= max) return { lines: [...lines], hidden: 0 };

  const keep = new Set<number>();
  for (let index = 0; index < lines.length && keep.size < max; index += 1) {
    if (isChange(lines[index]) || isHeader(lines[index])) keep.add(index);
  }
  // Context, nearest the top, for whatever room the changes did not take.
  for (let index = 0; index < lines.length && keep.size < max; index += 1) {
    keep.add(index);
  }

  const shown: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (keep.has(index)) shown.push(lines[index]);
  }
  return { lines: shown, hidden: lines.length - shown.length };
}

/**
 * `3 more lines`, as the affordance under a clipped preview reads.
 *
 * Spelled out rather than `+3`: the diff above it is full of `+` lines that mean
 * something else entirely.
 */
export function hiddenLabel(hidden: number): string {
  return `${hidden.toLocaleString()} more line${hidden === 1 ? "" : "s"}`;
}
