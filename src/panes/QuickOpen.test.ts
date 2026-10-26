import { describe, expect, it } from "vitest";
import type { ProjectGroup, SessionMeta } from "../lib/types";
import { buildEntries, filterEntries, type QuickOpenEntry, wantsNewWindow } from "./QuickOpen";

describe("wantsNewWindow", () => {
  const plain = { ctrlKey: false, metaKey: false, shiftKey: false };

  it("keeps a plain pick in this window", () => {
    expect(wantsNewWindow(plain)).toBe(false);
  });

  it("opens a new window on Ctrl, Cmd or Shift", () => {
    expect(wantsNewWindow({ ...plain, ctrlKey: true })).toBe(true);
    expect(wantsNewWindow({ ...plain, metaKey: true })).toBe(true);
    expect(wantsNewWindow({ ...plain, shiftKey: true })).toBe(true);
  });
});

function group(dirName: string, cwd: string, activity: number[]): ProjectGroup {
  return {
    dirName,
    cwd,
    label: cwd.split("/").pop() ?? cwd,
    sessions: activity.map((ms) => ({ status: "finished", lastActivityMs: ms }) as SessionMeta),
  };
}

describe("buildEntries", () => {
  it("folds groups that share a cwd into one row", () => {
    // A worktree's project dir whose session cd'd back to the main checkout.
    const entries = buildEntries(
      [
        group("-ws-mangouste", "/ws/mangouste", [100, 50]),
        group("-ws-mangouste--claude-worktrees-x", "/ws/mangouste", [300]),
      ],
      [{ path: "/ws/mangouste", name: "mangouste" }] as never,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: "/ws/mangouste", total: 3, lastActivityMs: 300 });
  });
});

describe("filterEntries", () => {
  const entry = (label: string): QuickOpenEntry => ({
    path: `/ws/${label}`,
    label,
    live: 0,
    total: 0,
    lastActivityMs: 0,
  });
  const all = [entry("mangouste"), entry("backend-service"), entry("swipejobs_ansible")];

  it("puts a name containing the query ahead of a scattered match", () => {
    expect(filterEntries(all, "ans").map((e) => e.label)).toEqual([
      "swipejobs_ansible",
      "mangouste",
      "backend-service",
    ]);
  });

  it("keeps the given order when nothing is typed", () => {
    expect(filterEntries(all, "  ")).toEqual(all);
  });
});
