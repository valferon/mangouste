import { describe, expect, it } from "vitest";
import {
  cleanVisits,
  MAX_VISITED,
  projectDirName,
  pruneVisits,
  repoLabel,
  VISIT_IDLE_AFTER_MS,
  visitedPlaceholders,
  withPlaceholders,
} from "./visitedRepos";
import type { ProjectGroup, SessionMeta } from "./types";

const NOW = Date.parse("2026-09-09T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function session(id: string): SessionMeta {
  return {
    id,
    file: `/p/${id}.jsonl`,
    projectDir: "/p",
    cwd: "/repo",
    gitBranch: null,
    title: id,
    lastPrompt: null,
    model: null,
    version: null,
    modifiedMs: NOW,
    lastActivityMs: NOW,
    sizeBytes: 0,
    status: "finished",
    messageCount: 1,
    messageCountExact: true,
    runningAgents: [],
    runningWorkflows: [],
    backgroundTasks: [],
  };
}

function group(cwd: string, label: string): ProjectGroup {
  return { dirName: projectDirName(cwd), cwd, label, sessions: [session(`s-${label}`)] };
}

describe("cleanVisits", () => {
  it("keeps well-formed entries and drops only the bad ones", () => {
    expect(
      cleanVisits({
        "/a": NOW,
        "/b": "yesterday",
        "/c": NOW - HOUR,
        "/d": Number.NaN,
        "/e": 0,
        "/f": -1,
        "": NOW,
      }),
    ).toEqual({ "/a": NOW, "/c": NOW - HOUR });
  });
});

describe("pruneVisits", () => {
  it("keeps the newest and returns the input when it already fits", () => {
    const fits = { "/a": NOW, "/b": NOW - HOUR };
    expect(pruneVisits(fits)).toBe(fits);

    const visits: Record<string, number> = {};
    for (let index = 0; index < MAX_VISITED + 5; index += 1) {
      visits[`/repo-${index}`] = NOW - index * HOUR;
    }
    const pruned = pruneVisits(visits);
    expect(Object.keys(pruned)).toHaveLength(MAX_VISITED);
    expect(pruned["/repo-0"]).toBe(NOW);
    expect(pruned[`/repo-${MAX_VISITED}`]).toBeUndefined();
  });
});

describe("path naming", () => {
  it("spells the dir name the way the scan would", () => {
    expect(projectDirName("/home/val/workspace/mangouste")).toBe(
      "-home-val-workspace-mangouste",
    );
  });

  it("labels a repo by its leaf, trailing slash or not", () => {
    expect(repoLabel("/home/val/workspace/mangouste")).toBe("mangouste");
    expect(repoLabel("/home/val/workspace/mangouste/")).toBe("mangouste");
    expect(repoLabel("/")).toBe("/");
  });
});

describe("visitedPlaceholders", () => {
  const visits = { "/w/flux": NOW - HOUR, "/w/mangouste": NOW - 2 * HOUR };

  it("only lists repos the rail is not already showing", () => {
    const rows = visitedPlaceholders(visits, ["/w/flux"], { now: NOW, includeIdle: false });
    expect(rows.map((row) => row.cwd)).toEqual(["/w/mangouste"]);
    expect(rows[0]).toMatchObject({
      dirName: "-w-mangouste",
      label: "mangouste",
      sessions: [],
    });
  });

  it("hides a visit past the idle line unless idle is included", () => {
    const stale = { "/w/old": NOW - VISIT_IDLE_AFTER_MS - HOUR };
    expect(visitedPlaceholders(stale, [], { now: NOW, includeIdle: false })).toEqual([]);
    expect(
      visitedPlaceholders(stale, [], { now: NOW, includeIdle: true }).map((row) => row.cwd),
    ).toEqual(["/w/old"]);
  });

  it("keeps a visit right up to the line", () => {
    const edge = { "/w/edge": NOW - VISIT_IDLE_AFTER_MS };
    expect(
      visitedPlaceholders(edge, [], { now: NOW, includeIdle: false }).map((row) => row.cwd),
    ).toEqual(["/w/edge"]);
  });

  it("takes an overridden window", () => {
    expect(
      visitedPlaceholders(visits, [], { now: NOW, includeIdle: false, afterMs: 30 * 60_000 }),
    ).toEqual([]);
  });
});

describe("withPlaceholders", () => {
  it("orders the merged list the way the scan orders itself", () => {
    const scanned = [group("/w/alpha", "alpha"), group("/w/zulu", "zulu")];
    const placeholders = visitedPlaceholders({ "/w/mike": NOW }, [], {
      now: NOW,
      includeIdle: false,
    });
    expect(withPlaceholders(scanned, placeholders).map((row) => row.label)).toEqual([
      "alpha",
      "mike",
      "zulu",
    ]);
  });

  it("sorts case-insensitively and breaks ties on the dir name", () => {
    const scanned = [group("/one/api", "api"), group("/two/API", "API")];
    const merged = withPlaceholders(scanned, []);
    expect(merged.map((row) => row.dirName)).toEqual(["-one-api", "-two-API"]);
  });

  it("hands back the scan untouched when nothing was visited", () => {
    const scanned = [group("/w/alpha", "alpha")];
    expect(withPlaceholders(scanned, [])).toBe(scanned);
  });
});
