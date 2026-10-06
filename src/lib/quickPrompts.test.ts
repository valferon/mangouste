import { describe, expect, it } from "vitest";
import {
  addPrompt,
  appendToDraft,
  cleanPrompts,
  deriveLabel,
  groupOf,
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
  newSession: false,
  project: null,
  schedule: null,
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

  it("reads an entry saved before new-session prompts existed", () => {
    const { newSession: _n, project: _p, schedule: _s, ...old } = prompt("a");
    expect(cleanPrompts([old])).toEqual([prompt("a")]);
  });

  it("drops an entry whose project is not a path", () => {
    expect(cleanPrompts([{ ...prompt("a"), project: 3 }])).toEqual([]);
  });

  it("fills a blank label from the text", () => {
    expect(cleanPrompts([prompt("a", { label: " ", text: "do it" })])[0].label).toBe("do it");
  });
});

describe("normaliseDraft", () => {
  it("refuses an empty text", () => {
    expect(normaliseDraft({ label: "x", text: " \n ", submit: true, newSession: false, project: null, schedule: null })).toBeNull();
  });

  it("trims the label and keeps the text verbatim", () => {
    expect(
      normaliseDraft({ label: "  go ", text: "  a\nb ", submit: true, newSession: false, project: null, schedule: null }),
    ).toEqual({ label: "go", text: "  a\nb ", submit: true, newSession: false, project: null, schedule: null });
  });

  it("keeps a project only for a new-session prompt", () => {
    const draft = { label: "", text: "x", submit: false, project: "/repo", schedule: null };
    expect(normaliseDraft({ ...draft, newSession: true })?.project).toBe("/repo");
    expect(normaliseDraft({ ...draft, newSession: false })?.project).toBeNull();
  });
});

describe("schedules", () => {
  const base = { label: "", text: "x", submit: false, newSession: false, project: "/r" };

  it("makes a scheduled prompt a new session that sends", () => {
    expect(normaliseDraft({ ...base, schedule: " 0 9 * * 1-5 " })).toEqual({
      label: "x",
      text: "x",
      submit: true,
      newSession: true,
      project: "/r",
      schedule: "0 9 * * 1-5",
    });
  });

  it("refuses a schedule that does not parse", () => {
    expect(normaliseDraft({ ...base, schedule: "every morning" })).toBeNull();
  });

  it("treats a blank schedule as none", () => {
    expect(normaliseDraft({ ...base, schedule: "  " })?.schedule).toBeNull();
  });

  it("drops a stored schedule that no longer parses, keeping the prompt", () => {
    expect(cleanPrompts([prompt("a", { schedule: "nope" })])).toEqual([prompt("a")]);
  });

  it("groups a scheduled prompt apart, even though it is a new session", () => {
    expect(groupOf(prompt("a", { newSession: true, schedule: "@daily" }))).toBe("scheduled");
    expect(groupOf(prompt("a", { newSession: true }))).toBe("new");
    expect(groupOf(prompt("a"))).toBe("here");
  });
});

describe("list edits", () => {
  const list = [prompt("a"), prompt("b"), prompt("c")];

  it("adds at the end without touching the input", () => {
    const next = addPrompt(list, { label: "", text: "new one", submit: true, newSession: false, project: null, schedule: null }, "d");
    expect(next.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
    expect(next[3]).toEqual(prompt("d", { label: "new one", text: "new one", submit: true }));
    expect(list).toHaveLength(3);
  });

  it("does not add an empty prompt", () => {
    expect(addPrompt(list, { label: "x", text: "", submit: false, newSession: false, project: null, schedule: null }, "d")).toEqual(list);
  });

  it("updates in place", () => {
    const next = updatePrompt(list, "b", {
      label: "B",
      text: "bee",
      submit: true,
      newSession: true,
      project: "/r",
      schedule: null,
    });
    expect(next[1]).toEqual(prompt("b", { label: "B", text: "bee", submit: true, newSession: true, project: "/r" }));
    expect(list[1]).toEqual(prompt("b"));
  });

  it("removes by id", () => {
    expect(removePrompt(list, "b").map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("moves past prompts of the other group", () => {
    const mixed = [prompt("a"), prompt("n", { newSession: true }), prompt("b")];
    expect(movePrompt(mixed, "b", -1).map((p) => p.id)).toEqual(["b", "n", "a"]);
    expect(movePrompt(mixed, "n", 1)).toEqual(mixed);
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
