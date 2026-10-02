import { describe, expect, it } from "vitest";
import {
  addPrompt,
  appendToDraft,
  cleanPrompts,
  deriveLabel,
  movePrompt,
  normaliseDraft,
  removePrompt,
  updatePrompt,
  type QuickPrompt,
} from "./quickPrompts";

const prompt = (id: string, overrides: Partial<QuickPrompt> = {}): QuickPrompt => ({
  id,
  label: id,
  text: `text ${id}`,
  submit: false,
  ...overrides,
});

describe("deriveLabel", () => {
  it("takes the first non-blank line", () => {
    expect(deriveLabel("\n  \n  check my mail\nthen more")).toBe("check my mail");
  });

  it("clips a long line", () => {
    const label = deriveLabel("x".repeat(200));
    expect(label.length).toBe(80);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("cleanPrompts", () => {
  it("is empty for anything that is not an array", () => {
    expect(cleanPrompts(null)).toEqual([]);
    expect(cleanPrompts({ id: "a" })).toEqual([]);
  });

  it("drops malformed entries and keeps the rest", () => {
    const good = prompt("a");
    expect(
      cleanPrompts([good, { id: "b" }, null, { ...prompt("c"), text: "   " }, "x"]),
    ).toEqual([good]);
  });

  it("drops a repeated id", () => {
    expect(cleanPrompts([prompt("a"), prompt("a", { label: "other" })])).toEqual([prompt("a")]);
  });

  it("fills a blank label from the text", () => {
    expect(cleanPrompts([prompt("a", { label: " ", text: "do it" })])[0].label).toBe("do it");
  });
});

describe("normaliseDraft", () => {
  it("refuses an empty text", () => {
    expect(normaliseDraft({ label: "x", text: " \n ", submit: true })).toBeNull();
  });

  it("trims the label and keeps the text verbatim", () => {
    expect(normaliseDraft({ label: "  go ", text: "  a\nb ", submit: true })).toEqual({
      label: "go",
      text: "  a\nb ",
      submit: true,
    });
  });
});

describe("list edits", () => {
  const list = [prompt("a"), prompt("b"), prompt("c")];

  it("adds at the end without touching the input", () => {
    const next = addPrompt(list, { label: "", text: "new one", submit: true }, "d");
    expect(next.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
    expect(next[3]).toEqual({ id: "d", label: "new one", text: "new one", submit: true });
    expect(list).toHaveLength(3);
  });

  it("does not add an empty prompt", () => {
    expect(addPrompt(list, { label: "x", text: "", submit: false }, "d")).toEqual(list);
  });

  it("updates in place", () => {
    const next = updatePrompt(list, "b", { label: "B", text: "bee", submit: true });
    expect(next[1]).toEqual({ id: "b", label: "B", text: "bee", submit: true });
    expect(list[1]).toEqual(prompt("b"));
  });

  it("removes by id", () => {
    expect(removePrompt(list, "b").map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("moves within bounds and stops at the ends", () => {
    expect(movePrompt(list, "b", -1).map((p) => p.id)).toEqual(["b", "a", "c"]);
    expect(movePrompt(list, "b", 1).map((p) => p.id)).toEqual(["a", "c", "b"]);
    expect(movePrompt(list, "a", -1)).toEqual(list);
    expect(movePrompt(list, "c", 1)).toEqual(list);
    expect(movePrompt(list, "zz", 1)).toEqual(list);
  });
});

describe("appendToDraft", () => {
  it("replaces an empty draft", () => {
    expect(appendToDraft("  ", "hello")).toBe("hello");
  });

  it("appends on its own line", () => {
    expect(appendToDraft("half a thought \n", "hello")).toBe("half a thought\nhello");
  });
});
