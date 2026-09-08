/**
 * Splitting text around the terms that matched it.
 *
 * The sweep in `sessions.rs` returns a snippet, not a highlight: it knows the
 * byte offsets it matched at, and a JS string is UTF-16, so handing those across
 * would be off by a byte on the first accented character. Re-finding the terms
 * here costs nothing on a 180-character snippet and cannot disagree with itself.
 */
export interface Segment {
  text: string;
  /** Part of a term the search matched, so it is what to paint. */
  hit: boolean;
}

/**
 * Split `text` into plain and matched runs, case-insensitively.
 *
 * Longest term first, so overlapping terms mark the longer one: searching
 * `rail sortable rail` must not leave a two-character stub where the longer
 * term already claimed the text. Adjacent matches are merged into one run,
 * because two `<mark>`s side by side draw two sets of edges through what is one
 * continuous hit.
 */
export function markTerms(text: string, terms: string[]): Segment[] {
  const needles = terms
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 0)
    .sort((a, b) => b.length - a.length);
  if (needles.length === 0 || text === "") return [{ text, hit: false }];

  const lower = text.toLowerCase();
  const segments: Segment[] = [];
  const push = (piece: string, hit: boolean) => {
    if (piece === "") return;
    const last = segments[segments.length - 1];
    if (last && last.hit === hit) last.text += piece;
    else segments.push({ text: piece, hit });
  };

  let at = 0;
  let plain = "";
  while (at < text.length) {
    const found = needles.find((needle) => lower.startsWith(needle, at));
    if (found === undefined) {
      plain += text[at];
      at += 1;
      continue;
    }
    push(plain, false);
    plain = "";
    push(text.slice(at, at + found.length), true);
    at += found.length;
  }
  push(plain, false);
  return segments;
}
