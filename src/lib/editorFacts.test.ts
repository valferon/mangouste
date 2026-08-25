import { describe, expect, it } from "vitest";

import {
  caretAt,
  clearEditorFacts,
  currentEditorFacts,
  describeIndent,
  detectEol,
  detectIndent,
  factsFor,
  languageName,
  publishEditorFacts,
  subscribeEditorFacts,
} from "./editorFacts";

describe("caretAt", () => {
  const text = "one\ntwo\nthree";

  it("counts from one, as editors do", () => {
    expect(caretAt(text, 0)).toEqual({ line: 1, column: 1 });
  });

  it("finds the line the offset is on", () => {
    expect(caretAt(text, 4)).toEqual({ line: 2, column: 1 });
    expect(caretAt(text, 6)).toEqual({ line: 2, column: 3 });
    expect(caretAt(text, text.length)).toEqual({ line: 3, column: 6 });
  });

  it("does not count a CRLF's carriage return as a column", () => {
    // The caret looks like it is after `one`, so column 4 is what it must say.
    expect(caretAt("one\r\ntwo", 3)).toEqual({ line: 1, column: 4 });
    expect(caretAt("one\r\ntwo", 5)).toEqual({ line: 2, column: 1 });
  });

  it("clamps an offset outside the buffer", () => {
    expect(caretAt(text, -5)).toEqual({ line: 1, column: 1 });
    expect(caretAt(text, 9999)).toEqual({ line: 3, column: 6 });
  });

  it("handles an empty buffer", () => {
    expect(caretAt("", 0)).toEqual({ line: 1, column: 1 });
  });
});

describe("detectEol", () => {
  it("reads the first line ending in the file", () => {
    expect(detectEol("a\nb")).toBe("LF");
    expect(detectEol("a\r\nb")).toBe("CRLF");
  });

  it("is LF when there is no line ending to read", () => {
    expect(detectEol("")).toBe("LF");
    expect(detectEol("one line")).toBe("LF");
  });

  it("takes the first when a file is mixed", () => {
    expect(detectEol("a\r\nb\nc")).toBe("CRLF");
    expect(detectEol("a\nb\r\nc")).toBe("LF");
  });
});

describe("detectIndent", () => {
  it("reports tabs when a leading run has one", () => {
    expect(detectIndent("if x:\n\tpass\n")).toEqual({ kind: "tabs", size: 4 });
  });

  it("takes the smallest indent, not the first one seen", () => {
    // The first indented line is six deep; the file indents by two.
    const text = "a\n      deep()\n  shallow()\n";
    expect(detectIndent(text)).toEqual({ kind: "spaces", size: 2 });
  });

  it("ignores a line that is only whitespace", () => {
    // A stray "   " line says nothing about how the code is indented.
    expect(detectIndent("a\n   \n    b\n")).toEqual({ kind: "spaces", size: 4 });
  });

  it("falls back to two spaces when nothing is indented", () => {
    expect(detectIndent("a\nb\n")).toEqual({ kind: "spaces", size: 2 });
    expect(detectIndent("")).toEqual({ kind: "spaces", size: 2 });
  });
});

describe("describeIndent", () => {
  it("labels them the way VSCode does", () => {
    expect(describeIndent({ kind: "spaces", size: 2 })).toBe("Spaces: 2");
    expect(describeIndent({ kind: "tabs", size: 4 })).toBe("Tab Size: 4");
  });
});

describe("languageName", () => {
  it("uses the display name where the id is not just uncapitalised", () => {
    expect(languageName("a.ts")).toBe("TypeScript");
    expect(languageName("a.md")).toBe("Markdown");
    expect(languageName("a.json")).toBe("JSON");
  });

  it("says Plain Text when nothing claims the file", () => {
    expect(languageName("LICENSE")).toBe("Plain Text");
  });
});

describe("factsFor", () => {
  it("derives the whole row in one pass", () => {
    expect(factsFor("/r/a.ts", "const a = 1;\n  const b = 2;\n", 15)).toEqual({
      path: "/r/a.ts",
      line: 2,
      column: 3,
      eol: "LF",
      indent: { kind: "spaces", size: 2 },
      language: "TypeScript",
    });
  });
});

describe("the store", () => {
  it("notifies subscribers and hands back what was published", () => {
    let calls = 0;
    const stop = subscribeEditorFacts(() => (calls += 1));
    const facts = factsFor("/r/a.ts", "x", 1);
    publishEditorFacts(facts);
    expect(calls).toBe(1);
    expect(currentEditorFacts()).toEqual(facts);
    stop();
  });

  it("clears only the file it was asked about", () => {
    // Two editors change places and both fire; a clear from the one going
    // hidden must not blank the row for the one now in front.
    publishEditorFacts(factsFor("/r/front.ts", "x", 1));
    clearEditorFacts("/r/hidden.ts");
    expect(currentEditorFacts()?.path).toBe("/r/front.ts");
    clearEditorFacts("/r/front.ts");
    expect(currentEditorFacts()).toBeNull();
  });

  it("stops notifying once unsubscribed", () => {
    let calls = 0;
    const stop = subscribeEditorFacts(() => (calls += 1));
    stop();
    publishEditorFacts(factsFor("/r/a.ts", "x", 1));
    expect(calls).toBe(0);
    clearEditorFacts("/r/a.ts");
  });
});
