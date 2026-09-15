import { describe, expect, it } from "vitest";
import { hiddenLabel, previewDiff } from "./editPreview";

describe("previewDiff", () => {
  it("leaves a diff that already fits exactly as it was written", () => {
    const diff = [" const a = 1;", "-const b = 2;", "+const b = 3;", " return a + b;"];
    expect(previewDiff(diff, 10)).toEqual({ lines: diff, hidden: 0 });
  });

  it("keeps the changed lines when context would have filled the preview", () => {
    // The change is at the bottom: a plain slice would preview six lines of
    // context and imply the edit changed nothing.
    const diff = [
      " one",
      " two",
      " three",
      " four",
      " five",
      " six",
      "-seven",
      "+SEVEN",
    ];
    const preview = previewDiff(diff, 3);
    // Kept in the order they were written, so the preview still reads as a
    // diff: the change is there, and one line of context came with it.
    expect(preview.lines).toEqual([" one", "-seven", "+SEVEN"]);
    expect(preview.hidden).toBe(5);
  });

  it("keeps hunk headers, which are what place the changes", () => {
    const diff = ["@@ edit 1 of 2 @@", "-a", "+b", "@@ edit 2 of 2 @@", "-c", "+d", " ctx"];
    expect(previewDiff(diff, 4).lines).toEqual(["@@ edit 1 of 2 @@", "-a", "+b", "@@ edit 2 of 2 @@"]);
  });

  it("holds the original order, whatever it kept", () => {
    // Changes are chosen first and context fills the rest, but what comes out
    // is in file order — a preview whose lines were reordered would not be a
    // diff any more.
    const diff = [" ctx", "+add", " ctx2", "-del"];
    expect(previewDiff(diff, 3).lines).toEqual([" ctx", "+add", "-del"]);
  });

  it("fills the leftover room with context, nearest the top", () => {
    const diff = [" a", " b", " c", "+d"];
    expect(previewDiff(diff, 3).lines).toEqual([" a", " b", "+d"]);
  });

  it("previews nothing when there is no room, and says how much it dropped", () => {
    expect(previewDiff([" a", "+b"], 0)).toEqual({ lines: [], hidden: 2 });
  });

  it("handles a Write, which is every line added and no context at all", () => {
    const whole = Array.from({ length: 40 }, (_, index) => `+line ${index}`);
    const preview = previewDiff(whole, 5);
    expect(preview.lines).toEqual(["+line 0", "+line 1", "+line 2", "+line 3", "+line 4"]);
    expect(preview.hidden).toBe(35);
  });
});

describe("hiddenLabel", () => {
  it("counts one line in the singular", () => {
    expect(hiddenLabel(1)).toBe("1 more line");
    expect(hiddenLabel(12)).toBe("12 more lines");
  });

  it("groups the thousands, because a Write really does reach them", () => {
    expect(hiddenLabel(2400)).toBe("2,400 more lines");
  });
});
