import { describe, expect, it } from "vitest";
import {
  asJson,
  classifyOutput,
  looksLikeDiff,
  parseNumberedLines,
  splitTrailer,
} from "./toolOutput";

describe("parseNumberedLines", () => {
  it("reads cat -n style output, either separator", () => {
    expect(parseNumberedLines("     1\timport x\n     2\t\n     3\ty = 1\n")).toEqual({
      lines: [
        { number: 1, text: "import x" },
        { number: 2, text: "" },
        { number: 3, text: "y = 1" },
      ],
      trailer: null,
    });
    expect(parseNumberedLines("10→a\n11→b")?.lines.map((l) => l.number)).toEqual([10, 11]);
  });

  it("keeps a tab inside the line", () => {
    expect(parseNumberedLines("5\tkey\tvalue")?.lines[0].text).toBe("key\tvalue");
  });

  it("hands back whatever followed the numbered run", () => {
    const parsed = parseNumberedLines("1\ta\n\n<system-reminder>\nx\n</system-reminder>");
    expect(parsed?.lines).toHaveLength(1);
    expect(parsed?.trailer).toBe("<system-reminder>\nx\n</system-reminder>");
  });

  it("is null for anything that does not start numbered", () => {
    expect(parseNumberedLines("")).toBeNull();
    expect(parseNumberedLines("File does not exist.")).toBeNull();
    expect(parseNumberedLines("<persisted-output>\n1\tx")).toBeNull();
  });
});

describe("splitTrailer", () => {
  it("peels the CLI's cwd note off the end", () => {
    expect(splitTrailer("out\nShell cwd was reset to /x\n")).toEqual({
      body: "out",
      trailer: "Shell cwd was reset to /x",
    });
    expect(splitTrailer("Shell cwd was reset to /x")).toEqual({
      body: "",
      trailer: "Shell cwd was reset to /x",
    });
  });

  it("leaves ordinary output alone", () => {
    expect(splitTrailer("a\nb\n")).toEqual({ body: "a\nb\n", trailer: null });
  });
});

describe("looksLikeDiff", () => {
  it("recognises git and plain unified diffs", () => {
    expect(looksLikeDiff(" a | 1 +\ndiff --git a/a b/a\nindex 1..2\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y")).toBe(true);
    expect(looksLikeDiff("--- a\t2026\n+++ b\t2026\n@@ -1 +1 @@\n-x\n+y")).toBe(true);
  });

  it("does not fire on markdown rules or lone hunks", () => {
    expect(looksLikeDiff("---\ntitle: x\n---\n+++ not a diff")).toBe(false);
    expect(looksLikeDiff("@@ -1 +1 @@")).toBe(false);
  });
});

describe("asJson", () => {
  it("pretty-prints one-line JSON and leaves formatted JSON as is", () => {
    expect(asJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(asJson('{\n  "a": 1\n}\n')).toBe('{\n  "a": 1\n}');
    expect(asJson("[1, 2]")).toBe("[\n  1,\n  2\n]");
  });

  it("is null for almost-JSON", () => {
    expect(asJson("{not json}")).toBeNull();
    expect(asJson("total 12\ndrwx")).toBeNull();
    expect(asJson("")).toBeNull();
    expect(asJson("{}\nShell cwd was reset")).toBeNull();
  });
});

describe("classifyOutput", () => {
  it("recognises a diff, then JSON, and nothing else", () => {
    const patch = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-x\n+y";
    expect(classifyOutput(patch).shape).toEqual({ kind: "diff", text: patch });
    expect(classifyOutput('{"a":1}').shape).toEqual({
      kind: "code",
      language: "json",
      text: '{\n  "a": 1\n}',
    });
    // A file dump is plain even when the command names the file: what a shell
    // printed is not knowable from the command, and a guess that sometimes
    // lands is worse than none.
    expect(classifyOutput("x = 1\n").shape).toEqual({ kind: "plain", text: "x = 1\n" });
    expect(classifyOutput("total 4\n").shape).toEqual({ kind: "plain", text: "total 4\n" });
  });

  it("separates the cwd trailer before deciding", () => {
    const out = classifyOutput('{"a":1}\nShell cwd was reset to /x');
    expect(out.shape.kind).toBe("code");
    expect(out.trailer).toBe("Shell cwd was reset to /x");
  });
});
