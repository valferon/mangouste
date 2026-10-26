import { describe, expect, it } from "vitest";
import {
  addPrompt,
  appendToDraft,
  claimMinute,
  cleanPrompts,
  deriveLabel,
  duplicateDraft,
  exportPrompts,
  fromLocalInput,
  groupOf,
  laterByDue,
  importPrompts,
  parseImport,
  toLocalInput,
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
  at: null,
  session: null,
  origin: null,
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
    expect(normaliseDraft({ label: "x", text: " \n ", submit: true, newSession: false, project: null, schedule: null, at: null, session: null, origin: null })).toBeNull();
  });

  it("trims the label and keeps the text verbatim", () => {
    expect(
      normaliseDraft({ label: "  go ", text: "  a\nb ", submit: true, newSession: false, project: null, schedule: null, at: null, session: null, origin: null }),
    ).toEqual({ label: "go", text: "  a\nb ", submit: true, newSession: false, project: null, schedule: null, at: null, session: null, origin: null });
  });

  it("keeps a project only for a new-session prompt", () => {
    const draft = { label: "", text: "x", submit: false, project: "/repo", schedule: null, at: null, session: null, origin: null };
    expect(normaliseDraft({ ...draft, newSession: true })?.project).toBe("/repo");
    expect(normaliseDraft({ ...draft, newSession: false })?.project).toBeNull();
  });
});

describe("schedules", () => {
  const base = { label: "", text: "x", submit: false, newSession: false, project: "/r", at: null, session: null, origin: null };

  it("makes a scheduled prompt a new session that sends", () => {
    expect(normaliseDraft({ ...base, schedule: " 0 9 * * 1-5 " })).toEqual({
      label: "x",
      text: "x",
      submit: true,
      newSession: true,
      project: "/r",
      schedule: "0 9 * * 1-5",
      at: null,
      session: null,
      origin: null,
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

  it("puts a one-off in the to-do list, soonest first", () => {
    const late = prompt("late", { newSession: true, at: "2026-11-23T09:30:00Z" });
    const soon = prompt("soon", { newSession: true, at: "2026-11-10T09:30:00Z" });
    const daily = prompt("daily", { newSession: true, schedule: "@daily" });
    expect(groupOf(soon)).toBe("later");
    expect(laterByDue([late, daily, soon, prompt("b")]).map((p) => p.id)).toEqual(["soon", "late"]);
  });
});

describe("list edits", () => {
  const list = [prompt("a"), prompt("b"), prompt("c")];

  it("adds at the end without touching the input", () => {
    const next = addPrompt(list, { label: "", text: "new one", submit: true, newSession: false, project: null, schedule: null, at: null, session: null, origin: null }, "d");
    expect(next.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
    expect(next[3]).toEqual(prompt("d", { label: "new one", text: "new one", submit: true }));
    expect(list).toHaveLength(3);
  });

  it("does not add an empty prompt", () => {
    expect(addPrompt(list, { label: "x", text: "", submit: false, newSession: false, project: null, schedule: null, at: null, session: null, origin: null }, "d")).toEqual(list);
  });

  it("updates in place", () => {
    const next = updatePrompt(list, "b", {
      label: "B",
      text: "bee",
      submit: true,
      newSession: true,
      project: "/r",
      schedule: null,
      at: null,
      session: null,
      origin: null,
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

describe("claimMinute", () => {
  const live = new Set(["a", "b"]);

  it("fires a cron once per minute, whichever window asks second", () => {
    const first = claimMinute({}, "a", 100, live);
    expect(first).toEqual({ a: 100 });
    // The window that took over mid-minute reads the same store.
    expect(claimMinute(first ?? {}, "a", 100, live)).toBeNull();
    expect(claimMinute(first ?? {}, "a", 101, live)).toEqual({ a: 101 });
  });

  it("drops the entries of prompts that are gone", () => {
    expect(claimMinute({ gone: 5, b: 7 }, "a", 100, live)).toEqual({ a: 100, b: 7 });
  });
});

describe("permissionMode", () => {
  it("is kept on a prompt that opens a fresh session", () => {
    const [kept] = cleanPrompts([prompt("a", { newSession: true, permissionMode: "bypassPermissions" })]);
    expect(kept.permissionMode).toBe("bypassPermissions");
  });

  it("drops an unknown mode but keeps the prompt", () => {
    const [kept] = cleanPrompts([{ ...prompt("a"), permissionMode: "yolo" }]);
    expect(kept).toBeDefined();
    expect(kept.permissionMode).toBeUndefined();
  });

  it("means nothing for a follow-up into a running session", () => {
    const draft = { ...prompt("a", { at: "2026-10-19T09:00:00.000Z", session: "s-1", permissionMode: "acceptEdits" }) };
    expect(normaliseDraft(draft)!.permissionMode).toBeUndefined();
  });

  it("means nothing for a prompt that pastes into the session in front", () => {
    expect(normaliseDraft(prompt("a", { permissionMode: "plan" }))!.permissionMode).toBeUndefined();
  });
});

describe("cleanPrompts permission modes", () => {
  it("keeps a mode only where a fresh session opens", () => {
    const [plain, fresh] = cleanPrompts([
      prompt("a", { permissionMode: "plan" }),
      prompt("b", { newSession: true, permissionMode: "plan" }),
    ]);
    expect(plain.permissionMode).toBeUndefined();
    expect(fresh.permissionMode).toBe("plan");
  });
});

describe("duplicateDraft", () => {
  it("is the user's own copy, never a follow-up or a session's", () => {
    const copy = duplicateDraft(
      prompt("a", { label: "check", at: "2026-10-20T09:00:00.000Z", session: "s-1", origin: "s-1" }),
    );
    expect(copy).toMatchObject({ label: "check (copy)", session: null, origin: null, newSession: true });
    expect(copy).not.toHaveProperty("id");
  });

  it("keeps a session's prompt off the app-wide mode", () => {
    expect(duplicateDraft(prompt("a", { origin: "s-1" })).permissionMode).toBe("default");
    expect(duplicateDraft(prompt("a", { origin: "s-1", permissionMode: "plan" })).permissionMode).toBe(
      "plan",
    );
    expect(duplicateDraft(prompt("a")).permissionMode).toBeUndefined();
  });
});

describe("export and import", () => {
  const NOW = new Date("2026-10-19T12:00:00.000Z");
  let ids = 0;
  const newId = () => `n${++ids}`;

  it("round-trips, under new ids, without sessions or origins", () => {
    const list = [
      prompt("a", { submit: true }),
      prompt("b", { schedule: "0 9 * * *", newSession: true, submit: true, origin: "s-1", project: "/r" }),
    ];
    const parsed = parseImport(exportPrompts(list), NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const imported = importPrompts([], parsed.prompts, false, newId);
    expect(imported.map((p) => p.label)).toEqual(["a", "b"]);
    expect(imported.every((p) => p.origin === null && p.session === null)).toBe(true);
    expect(imported.map((p) => p.id)).not.toContain("a");
    expect(imported[1].schedule).toBe("0 9 * * *");
  });

  it("drops permission modes unless asked to keep them", () => {
    const text = exportPrompts([prompt("a", { newSession: true, permissionMode: "bypassPermissions" })]);
    const parsed = parseImport(text, NOW);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(importPrompts([], parsed.prompts, false, newId)[0].permissionMode).toBeUndefined();
    expect(importPrompts([], parsed.prompts, true, newId)[0].permissionMode).toBe("bypassPermissions");
  });

  it("starts a timed import on default rather than the app-wide mode", () => {
    const text = exportPrompts([
      prompt("cron", { newSession: true, submit: true, schedule: "* * * * *", permissionMode: "bypassPermissions" }),
    ]);
    const parsed = parseImport(text, NOW);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(importPrompts([], parsed.prompts, false, newId)[0].permissionMode).toBe("default");
  });

  it("stops timed imports at the cap, counting the ones already held", () => {
    const text = exportPrompts([
      prompt("t1", { newSession: true, schedule: "@daily" }),
      prompt("t2", { newSession: true, schedule: "@daily" }),
      prompt("plain"),
    ]);
    const parsed = parseImport(text, NOW);
    if (!parsed.ok) throw new Error(parsed.error);
    const held = [prompt("x", { schedule: "@hourly" })];
    const imported = importPrompts(held, parsed.prompts, false, newId, 2);
    expect(imported.map((p) => p.label)).toEqual(["x", "t1", "plain"]);
  });

  it("leaves out one-offs already past, and counts them", () => {
    const text = exportPrompts([
      prompt("old", { at: "2026-10-18T09:00:00.000Z", newSession: true, submit: true }),
      prompt("soon", { at: "2026-10-20T09:00:00.000Z", newSession: true, submit: true }),
    ]);
    const parsed = parseImport(text, NOW);
    expect(parsed.ok && parsed.prompts.map((p) => p.label)).toEqual(["soon"]);
    expect(parsed.ok && parsed.expired).toBe(1);
  });

  it("refuses what is not a prompts file", () => {
    expect(parseImport("nope", NOW).ok).toBe(false);
    expect(parseImport('{"prompts": []}', NOW).ok).toBe(false);
    expect(parseImport("[]", NOW).ok).toBe(false);
  });

  it("takes a bare array, dropping entries that are not prompts", () => {
    const parsed = parseImport(JSON.stringify([{ label: "x", text: "hi", submit: false }, { text: 3 }]), NOW);
    expect(parsed.ok && parsed.prompts.map((p) => p.text)).toEqual(["hi"]);
  });
});

describe("datetime-local values", () => {
  it("round-trip to the minute", () => {
    const iso = "2026-10-20T09:30:00.000Z";
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
  });

  it("an empty value is no time", () => {
    expect(fromLocalInput("")).toBeNull();
    expect(toLocalInput("garbage")).toBe("");
  });
});
