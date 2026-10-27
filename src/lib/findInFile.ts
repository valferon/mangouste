/**
 * Text lookups for the editor: where a repo search result sits in the buffer,
 * and every match of the Ctrl+F box.
 *
 * Offsets out of here are UTF-16 indices into the buffer, which is what a
 * textarea's selection speaks. Columns in are 1-based characters, which is what
 * the Rust sweep reports — the two only agree on text with nothing outside the
 * BMP in it, so the conversion is done here once rather than assumed.
 */

/**
 * The text as a textarea holds it.
 *
 * A textarea's value normalises every line break to `\n`, so a CRLF file's
 * draft is one unit longer per line than the field showing it. Offsets meant
 * for the field's selection have to be counted in the field's text.
 */
export const asFieldText = (text: string): string => text.replace(/\r\n?/g, "\n");

/** A span of the buffer, `[start, end)` in UTF-16 units. */
export interface Span {
  start: number;
  end: number;
}

/** Where a repo search said the match was, as it read the file on disk. */
export interface MatchTarget {
  /** 1-based. */
  line: number;
  /** 1-based character column of the match's first character. */
  column: number;
  /** 1-based character column just past the match, on the same line. */
  endColumn: number;
  /**
   * The matched text, when the result carried all of it. Null when the snippet
   * cut it short, in which case the position is all there is to go on.
   */
  text: string | null;
}

/** Offset of each line's first character. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/** The line containing `offset`, 0-based, given `lineStarts`. */
function lineOf(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** UTF-16 length of the first `chars` characters of `line`, clamped to the line. */
function unitsFor(line: string, chars: number): number {
  let units = 0;
  for (const char of line) {
    if (chars <= 0) break;
    units += char.length;
    chars -= 1;
  }
  return units;
}

/**
 * The span a repo search result names, in this buffer.
 *
 * The sweep read the file on disk; the buffer may be a draft that has moved on
 * since, or a tab that was opened before claude rewrote the file. So the
 * reported position is only trusted when the matched text is actually there.
 * Otherwise the nearest copy of that text wins, by line distance, and only with
 * no copy at all does the bare position get used — clamped to a line that
 * exists, so the caret at least lands somewhere near.
 */
export function locateMatch(text: string, target: MatchTarget): Span {
  const starts = lineStarts(text);
  const index = Math.min(Math.max(target.line, 1), starts.length) - 1;
  const lineEnd = index + 1 < starts.length ? starts[index + 1] - 1 : text.length;
  const line = text.slice(starts[index], lineEnd).replace(/\r$/, "");
  const from = starts[index] + unitsFor(line, target.column - 1);
  const to = starts[index] + unitsFor(line, target.endColumn - 1);

  const wanted = target.text;
  if (wanted === null || wanted === "" || text.slice(from, to) === wanted) {
    return { start: from, end: Math.max(from, to) };
  }

  let best: Span | null = null;
  let bestDistance = Infinity;
  for (let at = text.indexOf(wanted); at !== -1; at = text.indexOf(wanted, at + 1)) {
    const distance = Math.abs(lineOf(starts, at) - index);
    if (distance < bestDistance) {
      best = { start: at, end: at + wanted.length };
      bestDistance = distance;
    }
  }
  return best ?? { start: from, end: Math.max(from, to) };
}

export interface FindOptions {
  caseSensitive: boolean;
  regex: boolean;
}

/** Matches past this are not highlighted; the count says so with a `+`. */
export const FIND_CAP = 10_000;

export interface FindResult {
  spans: Span[];
  /** More matches than `FIND_CAP`. */
  capped: boolean;
  /** The regex did not compile; its message, for the box to show. */
  error: string | null;
}

/** Literal text as a regex source. */
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `query` as a regex, flagged the way the repo sweep reads it.
 *
 * `m`, because the sweep matches line by line and `^`/`$` there mean the line's
 * ends; a find box where they meant the file's would disagree with it. Unicode
 * mode first, for `\p{…}` and astral characters, but without it as a fallback:
 * it refuses escapes of plain punctuation (`\"`, `\-`), which the Rust engine
 * and every other find box accept.
 */
function compile(query: string, options: FindOptions): RegExp {
  const source = options.regex ? query : escapeRegex(query);
  const flags = options.caseSensitive ? "gm" : "gim";
  try {
    return new RegExp(source, `${flags}u`);
  } catch {
    return new RegExp(source, flags);
  }
}

/**
 * Every match of `query` in `text`, in order.
 *
 * Empty matches are skipped, as the repo sweep skips them: `a*` would otherwise
 * report one hit per character and none of them is anything to look at.
 */
export function findAll(text: string, query: string, options: FindOptions): FindResult {
  if (query === "") return { spans: [], capped: false, error: null };
  let pattern: RegExp;
  try {
    pattern = compile(query, options);
  } catch (e) {
    return { spans: [], capped: false, error: e instanceof Error ? e.message : String(e) };
  }
  const spans: Span[] = [];
  for (const found of text.matchAll(pattern)) {
    if (found[0] === "") continue;
    if (spans.length >= FIND_CAP) return { spans, capped: true, error: null };
    spans.push({ start: found.index, end: found.index + found[0].length });
  }
  return { spans, capped: false, error: null };
}

/**
 * The match the box should land on first: the one at or after `caret`, or the
 * first in the file when the caret is past the last. -1 with no matches.
 */
export function nearestFrom(spans: Span[], caret: number): number {
  if (spans.length === 0) return -1;
  const after = spans.findIndex((span) => span.start >= caret);
  return after === -1 ? 0 : after;
}
