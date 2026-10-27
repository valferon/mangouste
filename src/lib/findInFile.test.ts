import { describe, expect, it } from "vitest";

import { FIND_CAP, asFieldText, findAll, locateMatch, nearestFrom } from "./findInFile";

describe("locateMatch", () => {
  const text = "alpha\n    Feature(\"AI\", True),\nomega";

  it("selects the match itself, not the rest of the line", () => {
    const span = locateMatch(text, { line: 2, column: 14, endColumn: 16, text: "AI" });
    expect(text.slice(span.start, span.end)).toBe("AI");
  });

  it("finds the text on a nearby line when the buffer has moved on from disk", () => {
    // Disk said line 3; the draft has one line fewer above it.
    const draft = "    Feature(\n    Feature(\"AI\", True),\n    (\"AI\", True),";
    const span = locateMatch(draft, { line: 3, column: 14, endColumn: 16, text: "AI" });
    expect(span.start).toBe(draft.lastIndexOf("AI"));

    const near = locateMatch(draft, { line: 2, column: 1, endColumn: 3, text: "AI" });
    expect(near.start).toBe(draft.indexOf("AI"));
  });

  it("falls back to the position when the text is gone", () => {
    const span = locateMatch(text, { line: 2, column: 5, endColumn: 12, text: "missing" });
    expect(text.slice(span.start, span.end)).toBe("Feature");
  });

  it("trusts the position when the snippet was cut short", () => {
    const span = locateMatch(text, { line: 1, column: 2, endColumn: 4, text: null });
    expect(text.slice(span.start, span.end)).toBe("lp");
  });

  it("clamps a line past the end, and a column past the line", () => {
    const span = locateMatch(text, { line: 99, column: 50, endColumn: 60, text: null });
    expect(span).toEqual({ start: text.length, end: text.length });
  });

  it("counts columns in characters, not UTF-16 units", () => {
    const astral = "😀 x";
    const span = locateMatch(astral, { line: 1, column: 3, endColumn: 4, text: "x" });
    expect(astral.slice(span.start, span.end)).toBe("x");
  });

  it("ignores a CRLF's carriage return", () => {
    const crlf = "ab\r\ncd";
    const span = locateMatch(crlf, { line: 1, column: 1, endColumn: 9, text: null });
    expect(crlf.slice(span.start, span.end)).toBe("ab");
  });
});

describe("findAll", () => {
  const plain = { caseSensitive: false, regex: false };

  it("finds every literal match, ignoring case by default", () => {
    const result = findAll("Ab ab AB", "ab", plain);
    expect(result.spans.map((s) => s.start)).toEqual([0, 3, 6]);
  });

  it("respects case when asked", () => {
    const result = findAll("Ab ab AB", "ab", { ...plain, caseSensitive: true });
    expect(result.spans).toEqual([{ start: 3, end: 5 }]);
  });

  it("treats regex characters literally unless regex is on", () => {
    expect(findAll("a.c abc", "a.c", plain).spans).toHaveLength(1);
    expect(findAll("a.c abc", "a.c", { ...plain, regex: true }).spans).toHaveLength(2);
  });

  it("reports a bad regex instead of throwing", () => {
    const result = findAll("text", "(", { ...plain, regex: true });
    expect(result.error).not.toBeNull();
    expect(result.spans).toEqual([]);
  });

  it("anchors ^ and $ to lines, as the repo search does", () => {
    const text = "foo\nbar foo\nfoo";
    const result = findAll(text, "^foo$", { ...plain, regex: true });
    expect(result.spans.map((s) => s.start)).toEqual([0, 12]);
  });

  it("accepts escaped punctuation that unicode mode refuses", () => {
    const result = findAll('say "hi"', '\\"hi\\"', { ...plain, regex: true });
    expect(result.error).toBeNull();
    expect(result.spans).toEqual([{ start: 4, end: 8 }]);
  });

  it("skips empty matches", () => {
    expect(findAll("bbb", "a*", { ...plain, regex: true }).spans).toEqual([]);
  });

  it("stops at the cap", () => {
    const result = findAll("x".repeat(FIND_CAP + 5), "x", plain);
    expect(result.spans).toHaveLength(FIND_CAP);
    expect(result.capped).toBe(true);
  });

  it("finds nothing for an empty query", () => {
    expect(findAll("text", "", plain).spans).toEqual([]);
  });
});

describe("asFieldText", () => {
  it("turns every line break into the \\n a textarea holds", () => {
    expect(asFieldText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});

describe("nearestFrom", () => {
  const spans = [
    { start: 2, end: 3 },
    { start: 10, end: 11 },
  ];

  it("picks the first match at or after the caret", () => {
    expect(nearestFrom(spans, 0)).toBe(0);
    expect(nearestFrom(spans, 5)).toBe(1);
    expect(nearestFrom(spans, 10)).toBe(1);
  });

  it("wraps to the first when the caret is past the last", () => {
    expect(nearestFrom(spans, 50)).toBe(0);
  });

  it("is -1 with nothing to land on", () => {
    expect(nearestFrom([], 0)).toBe(-1);
  });
});
