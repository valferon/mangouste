import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn() }));

import {
  alreadyDone,
  browsePlugins,
  isWritableScope,
  runMessage,
  shownCommandOf,
  splitPluginId,
  type AvailablePlugin,
  type PluginRun,
} from "./plugins";

const plugin = (name: string, marketplace: string, installCount = 0, description = "") => ({
  pluginId: `${name}@${marketplace}`,
  name,
  marketplaceName: marketplace,
  installCount,
  description,
});

const run = (result: Record<string, unknown> | null, ok = false, message = ""): PluginRun => ({
  ok,
  result,
  message,
});

describe("splitPluginId", () => {
  it("splits on the last @", () => {
    expect(splitPluginId("caveman@caveman")).toEqual({ name: "caveman", marketplace: "caveman" });
    expect(splitPluginId("@scope/pkg@npm")).toEqual({ name: "@scope/pkg", marketplace: "npm" });
  });

  it("leaves a bare name whole", () => {
    expect(splitPluginId("caveman")).toEqual({ name: "caveman", marketplace: "" });
  });
});

describe("isWritableScope", () => {
  it("allows the scopes the CLI writes and refuses the ones it owns", () => {
    expect(isWritableScope("user")).toBe(true);
    expect(isWritableScope("local")).toBe(true);
    expect(isWritableScope("synced")).toBe(false);
    expect(isWritableScope("managed")).toBe(false);
  });
});

describe("browsePlugins", () => {
  const catalog: AvailablePlugin[] = [
    plugin("alpha", "official", 10, "Lint your SQL"),
    plugin("beta", "official", 500, "Kubernetes helpers"),
    plugin("gamma", "community", 50, "sql formatter"),
    plugin("delta", "official", 500),
  ];

  it("ranks by install count, then by name", () => {
    const { rows } = browsePlugins(catalog, new Set(), "", "");
    expect(rows.map((p) => p.name)).toEqual(["beta", "delta", "gamma", "alpha"]);
  });

  it("matches every word, case-insensitively, across name and description", () => {
    const { rows, total } = browsePlugins(catalog, new Set(), "SQL", "");
    expect(rows.map((p) => p.name)).toEqual(["gamma", "alpha"]);
    expect(total).toBe(2);
    expect(browsePlugins(catalog, new Set(), "sql lint", "").rows.map((p) => p.name)).toEqual([
      "alpha",
    ]);
  });

  it("hides what is installed and filters by marketplace", () => {
    const { rows } = browsePlugins(catalog, new Set(["beta@official"]), "", "official");
    expect(rows.map((p) => p.name)).toEqual(["delta", "alpha"]);
  });

  it("caps the rows but counts every match", () => {
    const { rows, total } = browsePlugins(catalog, new Set(), "", "", 2);
    expect(rows).toHaveLength(2);
    expect(total).toBe(4);
  });
});

describe("shownCommandOf", () => {
  const sha = "ab".repeat(32);

  it("reads the command and its fingerprint", () => {
    expect(shownCommandOf(run({ shownCommand: { command: "npx thing", sha256: sha } }))).toEqual({
      text: "npx thing",
      sha256: sha,
    });
  });

  it("falls back to the whole record when the command is not a string", () => {
    const shown = shownCommandOf(run({ shownCommand: { argv: ["a"], sha256: sha } }));
    expect(shown?.text).toContain('"argv"');
  });

  it("refuses anything without a real fingerprint", () => {
    expect(shownCommandOf(run({ shownCommand: { command: "x", sha256: "nope" } }))).toBeNull();
    expect(shownCommandOf(run(null))).toBeNull();
  });
});

describe("runMessage and alreadyDone", () => {
  it("prefers the result line's message", () => {
    expect(runMessage(run({ message: "Installed x" }, true, "noise"))).toBe("Installed x");
  });

  it("falls back to the last printed line", () => {
    expect(runMessage(run(null, false, "Cloning\n✘ network down\n"))).toBe("✘ network down");
    expect(runMessage(run(null, true, ""))).toBe("done");
  });

  it("knows a no-op refusal", () => {
    expect(alreadyDone(run({ alreadyInGoalState: true }))).toBe(true);
    expect(alreadyDone(run({ outcome: "failed" }))).toBe(false);
  });
});
