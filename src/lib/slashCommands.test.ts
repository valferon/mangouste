import { describe, expect, it } from "vitest";
import { applyCompletion, buildMenu, detectTrigger, toNative } from "./slashCommands";
import type { SlashCommand } from "./types";

describe("toNative", () => {
  it("resolves a native command and its aliases, whatever the case", () => {
    expect(toNative("model")).toBe("model");
    expect(toNative("Models")).toBe("model");
    expect(toNative("perms")).toBe("permissions");
  });

  it("leaves everything else to the CLI", () => {
    expect(toNative("commit")).toBeNull();
  });

  /**
   * `in` walks the prototype chain, so a command named after anything an
   * object inherits was taken for a native one: it opened an empty panel and
   * never reached the CLI.
   */
  it("does not mistake an inherited property for a command", () => {
    expect(toNative("constructor")).toBeNull();
    expect(toNative("__proto__")).toBeNull();
    expect(toNative("toString")).toBeNull();
  });

  it("keeps a catalog command of such a name on the menu", () => {
    const catalog = [{ name: "constructor", description: "a plugin's own" }] as SlashCommand[];
    expect(buildMenu(catalog).some((entry) => entry.name === "constructor")).toBe(true);
  });
});

describe("applyCompletion", () => {
  it("replaces a command typed to the caret", () => {
    const draft = "/mo";
    const trigger = detectTrigger(draft, draft.length);
    expect(trigger).not.toBeNull();
    expect(applyCompletion(draft, trigger!, draft.length, "/model ")).toEqual({
      draft: "/model ",
      caret: 7,
    });
  });

  /**
   * The menu matches on the whole token, so the pick has to replace the whole
   * token. Cut at the caret, the rest of it was left behind as an argument:
   * `/model` with the caret after `/mo` became `/model del`.
   */
  it("replaces the whole command when the caret is inside it", () => {
    const draft = "/model";
    const trigger = detectTrigger(draft, 3);
    expect(applyCompletion(draft, trigger!, 3, "/model ")).toEqual({
      draft: "/model ",
      caret: 7,
    });
  });

  /**
   * A mention is different: its query is only what sits before the caret, so
   * that is all a pick replaces. Text after the caret is the person's own.
   */
  it("replaces a mention up to the caret and keeps what follows", () => {
    const draft = "see @src, and more";
    const caret = "see @src".length;
    const trigger = detectTrigger(draft, caret);
    expect(trigger).toEqual({ kind: "file", query: "src", start: 4 });
    const next = applyCompletion(draft, trigger!, caret, "@src/lib/paths.ts ");
    expect(next.draft).toBe("see @src/lib/paths.ts , and more");
    expect(next.caret).toBe("see @src/lib/paths.ts ".length);
  });
});
