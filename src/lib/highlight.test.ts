import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { highlightDiff, highlightLines, languageForPath, runsByLine } from "./highlight";

/** The text a node list renders, colours discarded. */
function textOf(nodes: ReactNode[]): string {
  return nodes
    .map((node): string => {
      if (typeof node === "string") return node;
      if (!isValidElement(node)) return "";
      const children = (node as ReactElement<{ children?: ReactNode }>).props.children;
      return textOf(Array.isArray(children) ? children : [children]);
    })
    .join("");
}

/** Every class name reachable in a node list. */
function classesOf(nodes: ReactNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (!isValidElement(node)) continue;
    const props = (node as ReactElement<{ className?: string; children?: ReactNode }>).props;
    if (props.className) out.push(props.className);
    const children = props.children;
    out.push(...classesOf(Array.isArray(children) ? children : [children]));
  }
  return out;
}

describe("runsByLine", () => {
  it("cuts text at newlines and carries the open scopes over", () => {
    const lines = runsByLine([
      { type: "text", value: "a\n" },
      {
        type: "element",
        tagName: "span",
        properties: { className: ["hljs-string"] },
        children: [{ type: "text", value: "'one\ntwo'" }],
      },
      { type: "text", value: "\nz" },
    ]);
    expect(lines).toEqual([
      [{ text: "a", scopes: [] }],
      [{ text: "'one", scopes: ["hljs-string"] }],
      [{ text: "two'", scopes: ["hljs-string"] }],
      [{ text: "z", scopes: [] }],
    ]);
  });
});

describe("highlightLines", () => {
  const code = 'def f():\n    """doc\n    string"""\n    return 1\n';

  it("returns exactly one entry per source line, highlighted or not", () => {
    expect(highlightLines(code, "python")).toHaveLength(code.split("\n").length);
    expect(highlightLines(code, null)).toHaveLength(code.split("\n").length);
    expect(highlightLines(code, "no-such-language")).toEqual(code.split("\n").map((l) => [l]));
  });

  it("reproduces the source text line for line", () => {
    const lines = highlightLines(code, "python");
    expect(lines.map(textOf)).toEqual(code.split("\n"));
  });

  it("colours the inside of a multi-line string on its later lines", () => {
    const lines = highlightLines(code, "python");
    expect(classesOf(lines[2])).toContain("hljs-string");
  });

  it("stays plain past the size cap", () => {
    expect(highlightLines(code, "python", 10)).toEqual(code.split("\n").map((l) => [l]));
  });
});

describe("highlightDiff", () => {
  const lines = [
    "@@ -1,3 +1,3 @@",
    " def f():",
    '-    return "old"',
    '+    return "new"',
    "     pass",
  ];

  it("keeps the marker as a plain leading string and the text intact", () => {
    const out = highlightDiff(lines, "python");
    expect(out).toHaveLength(lines.length);
    expect(out[0]).toEqual([lines[0]]);
    expect(out[2][0]).toBe("-");
    expect(out[3][0]).toBe("+");
    expect(out.map(textOf)).toEqual(lines);
  });

  it("highlights each side as its own program", () => {
    const out = highlightDiff(lines, "python");
    expect(classesOf(out[2])).toContain("hljs-string");
    expect(classesOf(out[3])).toContain("hljs-string");
    expect(classesOf(out[1])).toContain("hljs-keyword");
  });

  it("copes with a side that has nothing in it", () => {
    const added = ["+a = 1", "+b = 2"];
    const out = highlightDiff(added, "python");
    expect(out.map(textOf)).toEqual(added);
    expect(highlightDiff(["-gone"], "python").map(textOf)).toEqual(["-gone"]);
  });

  it("is plain without a language", () => {
    expect(highlightDiff(lines, null)).toEqual(lines.map((l) => [l]));
  });
});

describe("languageForPath", () => {
  it("resolves common extensions and named files", () => {
    expect(languageForPath("a/b/c.py")).toBe("py");
    expect(languageForPath("Dockerfile")).toBe("dockerfile");
    expect(languageForPath("x.txt.j2")).toBeNull();
  });
});
