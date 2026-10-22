import { describe, expect, it } from "vitest";
import {
  breadcrumbs,
  closePane,
  followRepoSwitch,
  growShares,
  isPaneList,
  parentOf,
  rerootPane,
  resizePanes,
  resolveTyped,
  splitPane,
  type ExplorerPane,
} from "./explorerPanes";

const HOME = "/home/val";
const REPO = "/home/val/workspace/mangouste";

const pane = (id: string, root: string | null = null, weight = 1): ExplorerPane => ({
  id,
  root,
  weight,
});

describe("breadcrumbs", () => {
  it("collapses the home prefix into one crumb", () => {
    expect(breadcrumbs(REPO, HOME)).toEqual([
      { label: "~", path: HOME },
      { label: "workspace", path: "/home/val/workspace" },
      { label: "mangouste", path: REPO },
    ]);
  });

  it("spells a path outside home from the filesystem root", () => {
    expect(breadcrumbs("/etc/nginx/", HOME)).toEqual([
      { label: "/", path: "/" },
      { label: "etc", path: "/etc" },
      { label: "nginx", path: "/etc/nginx" },
    ]);
  });

  it("does not mistake a sibling of home for home", () => {
    expect(breadcrumbs("/home/valerie", HOME)[0]).toEqual({ label: "/", path: "/" });
  });

  it("handles home itself and the root", () => {
    expect(breadcrumbs(HOME, HOME)).toEqual([{ label: "~", path: HOME }]);
    expect(breadcrumbs("/", HOME)).toEqual([{ label: "/", path: "/" }]);
  });
});

describe("resolveTyped", () => {
  it("expands ~ and collapses dot segments", () => {
    expect(resolveTyped("~/.claude", REPO, HOME)).toBe("/home/val/.claude");
    expect(resolveTyped("~", REPO, HOME)).toBe(HOME);
    expect(resolveTyped("/etc/../var/./log/", REPO, HOME)).toBe("/var/log");
  });

  it("resolves a relative path against the pane's root", () => {
    expect(resolveTyped("../flux-v2", REPO, HOME)).toBe("/home/val/workspace/flux-v2");
    expect(resolveTyped("src", REPO, HOME)).toBe(`${REPO}/src`);
  });

  it("refuses blanks, and ~ without a home", () => {
    expect(resolveTyped("   ", REPO, HOME)).toBeNull();
    expect(resolveTyped("~/x", REPO, null)).toBeNull();
  });

  it("cannot climb above the root", () => {
    expect(resolveTyped("/../../", REPO, HOME)).toBe("/");
  });
});

describe("parentOf", () => {
  it("walks up to the root and stops", () => {
    expect(parentOf(REPO)).toBe("/home/val/workspace");
    expect(parentOf("/etc")).toBe("/");
    expect(parentOf("/")).toBeNull();
  });
});

describe("rerootPane", () => {
  it("pins a pane to a directory, and unpins it when pointed back at the repo", () => {
    const pinned = rerootPane([pane("a")], "a", "/etc", REPO);
    expect(pinned[0].root).toBe("/etc");
    expect(rerootPane(pinned, "a", REPO, REPO)[0].root).toBeNull();
  });

  it("returns the same pane object when nothing changes", () => {
    const panes = [pane("a", "/etc")];
    expect(rerootPane(panes, "a", "/etc", REPO)[0]).toBe(panes[0]);
  });
});

describe("splitPane", () => {
  it("inserts below the split pane and halves its weight", () => {
    const panes = splitPane([pane("a", null, 2), pane("b")], "a", "c", "/etc");
    expect(panes.map((p) => p.id)).toEqual(["a", "c", "b"]);
    expect(panes.map((p) => p.weight)).toEqual([1, 1, 1]);
    expect(panes[1].root).toBe("/etc");
  });

  it("copies the split pane's root when none is given", () => {
    expect(splitPane([pane("a", "/opt")], "a", "b")[1].root).toBe("/opt");
  });
});

describe("closePane", () => {
  it("keeps the last pane", () => {
    const only = [pane("a")];
    expect(closePane(only, "a")).toBe(only);
    expect(closePane([pane("a"), pane("b")], "a").map((p) => p.id)).toEqual(["b"]);
  });

  it("gives a closed split's height back to the pane it came from", () => {
    const split = splitPane([pane("a")], "a", "b");
    expect(closePane(split, "b")).toEqual([pane("a", null, 1)]);
  });

  it("hands the top pane's weight down, and leaves the others alone", () => {
    const panes = [pane("a", null, 1), pane("b", null, 2), pane("c", null, 3)];
    expect(closePane(panes, "a").map((p) => p.weight)).toEqual([3, 3]);
    expect(closePane(panes, "c").map((p) => p.weight)).toEqual([1, 5]);
  });
});

describe("growShares", () => {
  it("always sums to one, even for a lone pane left at half weight", () => {
    expect(growShares([pane("a", null, 0.5)])).toEqual([1]);
    expect(growShares([pane("a", null, 1), pane("b", null, 3)])).toEqual([0.25, 0.75]);
  });
});

describe("resizePanes", () => {
  it("moves weight across the divider and clamps at the minimum share", () => {
    const panes = [pane("a"), pane("b")];
    const grown = resizePanes(panes, 1, 25, 100);
    expect(grown[0].weight).toBeCloseTo(1.5);
    expect(grown[1].weight).toBeCloseTo(0.5);
    const clamped = resizePanes(panes, 1, 10_000, 100);
    expect(clamped[1].weight).toBeCloseTo(0.16);
  });

  it("ignores a divider that does not exist", () => {
    const panes = [pane("a")];
    expect(resizePanes(panes, 1, 10, 100)).toBe(panes);
  });
});

describe("followRepoSwitch", () => {
  it("puts only the top pane back on the repo", () => {
    const next = followRepoSwitch([pane("a", "/etc"), pane("b", "/opt")]);
    expect(next.map((p) => p.root)).toEqual([null, "/opt"]);
  });
});

describe("isPaneList", () => {
  it("accepts a stored stack and rejects junk", () => {
    expect(isPaneList([pane("a"), pane("b", "/etc", 0.5)])).toBe(true);
    expect(isPaneList([])).toBe(false);
    expect(isPaneList([{ id: "a", root: "relative", weight: 1 }])).toBe(false);
    expect(isPaneList([{ id: "a", root: null, weight: 0 }])).toBe(false);
    expect(isPaneList("nope")).toBe(false);
  });

  it("rejects duplicate ids and roots the stack would never write", () => {
    expect(isPaneList([pane("a"), pane("a")])).toBe(false);
    expect(isPaneList([pane("a", "/etc/")])).toBe(false);
    expect(isPaneList([pane("a", "/a/../b")])).toBe(false);
    expect(isPaneList([pane("a", "/")])).toBe(true);
  });
});
