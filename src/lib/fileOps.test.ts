import { describe, expect, it } from "vitest";
import {
  ancestorsBetween,
  deleteWarning,
  draftPath,
  dropTarget,
  isUnder,
  moveTarget,
  nameError,
  refreshTargets,
  repointPath,
} from "./fileOps";

describe("nameError", () => {
  it("accepts a plain name and a nested one", () => {
    expect(nameError("notes.md")).toBeNull();
    expect(nameError(".gitignore")).toBeNull();
    expect(nameError("api/routes/users.ts")).toBeNull();
    expect(nameError("a name with spaces.txt")).toBeNull();
  });

  it("rejects an empty name, whitespace included", () => {
    expect(nameError("")).toBe("Name cannot be empty");
    expect(nameError("   ")).toBe("Name cannot be empty");
  });

  /** The one case where a plausible name silently targets another directory. */
  it("rejects . and .. anywhere in the path", () => {
    expect(nameError("..")).toBe("Name cannot contain . or ..");
    expect(nameError("../escaped.txt")).toBe("Name cannot contain . or ..");
    expect(nameError("src/../../etc/passwd")).toBe("Name cannot contain . or ..");
    expect(nameError("a/./b")).toBe("Name cannot contain . or ..");
    // A leading dot is a dotfile, not a parent reference.
    expect(nameError("src/.env")).toBeNull();
  });

  it("rejects absolute, trailing-slash and doubled-slash names", () => {
    expect(nameError("/etc/passwd")).toBe("Name cannot start with /");
    expect(nameError("folder/")).toBe("Name cannot end with /");
    expect(nameError("a//b")).toBe("Name cannot contain an empty path segment");
  });

  it("rejects a segment no filesystem would take", () => {
    expect(nameError("x".repeat(256))).toBe("Name is too long");
    expect(nameError(`${"x".repeat(255)}/ok.txt`)).toBeNull();
    expect(nameError("null\0byte")).toBe("Name cannot contain a null byte");
  });
});

describe("draftPath", () => {
  it("joins onto the directory the row sits in", () => {
    expect(draftPath("/repo/src", "a.ts")).toBe("/repo/src/a.ts");
    expect(draftPath("/repo/src", "api/users.ts")).toBe("/repo/src/api/users.ts");
  });

  it("does not double the separator or keep stray whitespace", () => {
    expect(draftPath("/repo/src/", "a.ts")).toBe("/repo/src/a.ts");
    expect(draftPath("/repo/src", "  a.ts  ")).toBe("/repo/src/a.ts");
  });
});

describe("isUnder", () => {
  it("counts the directory itself and its descendants, not a name sharing a prefix", () => {
    expect(isUnder("/repo/src", "/repo/src")).toBe(true);
    expect(isUnder("/repo/src/a/b.ts", "/repo/src")).toBe(true);
    expect(isUnder("/repo/src-tauri/lib.rs", "/repo/src")).toBe(false);
  });
});

describe("dropTarget", () => {
  it("drops into a folder and beside a file", () => {
    expect(dropTarget("/repo/src", true)).toBe("/repo/src");
    expect(dropTarget("/repo/src/a.ts", false)).toBe("/repo/src");
  });
});

describe("moveTarget", () => {
  it("keeps the name and changes the parent", () => {
    expect(moveTarget("/repo/a.ts", "/repo/src")).toEqual({ path: "/repo/src/a.ts" });
  });

  /** The three refusals a drag can produce by accident. */
  it("refuses a no-op, a folder onto itself and a folder into its own subtree", () => {
    expect(moveTarget("/repo/src/a.ts", "/repo/src")).toEqual({ error: "Already there" });
    expect(moveTarget("/repo/src", "/repo/src")).toEqual({
      error: "Cannot move a folder into itself",
    });
    expect(moveTarget("/repo/src", "/repo/src/nested")).toEqual({
      error: "Cannot move a folder into itself",
    });
    expect(moveTarget("/repo/a.ts", "")).toEqual({ error: "No destination" });
  });

  it("allows a move into a sibling whose path shares a prefix", () => {
    expect(moveTarget("/repo/src", "/repo/src-tauri")).toEqual({
      path: "/repo/src-tauri/src",
    });
  });
});

describe("repointPath", () => {
  it("follows the renamed path itself", () => {
    expect(repointPath("/repo/a.ts", "/repo/a.ts", "/repo/b.ts")).toBe("/repo/b.ts");
  });

  /** What makes this more than a compare: open tabs under a renamed folder. */
  it("carries descendants across a folder rename", () => {
    expect(repointPath("/repo/src/a/b.ts", "/repo/src", "/repo/lib")).toBe("/repo/lib/a/b.ts");
  });

  it("leaves an unrelated path, and a prefix twin, alone", () => {
    expect(repointPath("/repo/other.ts", "/repo/a.ts", "/repo/b.ts")).toBeNull();
    expect(repointPath("/repo/src-tauri/lib.rs", "/repo/src", "/repo/lib")).toBeNull();
  });
});

describe("ancestorsBetween", () => {
  it("is just the directory itself for a plain name", () => {
    expect(ancestorsBetween("/repo/src", "/repo/src/a.ts")).toEqual(["/repo/src"]);
  });

  /** The directories a nested create just made, which have to be opened. */
  it("lists each directory a nested create passes through", () => {
    expect(ancestorsBetween("/repo", "/repo/api/routes/users.ts")).toEqual([
      "/repo",
      "/repo/api",
      "/repo/api/routes",
    ]);
  });

  it("is empty when the path is not under the directory at all", () => {
    expect(ancestorsBetween("/repo/src", "/repo/other/a.ts")).toEqual([]);
  });
});

describe("deleteWarning", () => {
  it("says permanent, because it is", () => {
    expect(deleteWarning("/repo/a.ts", false)).toContain("Permanently delete the file");
    expect(deleteWarning("/repo/a.ts", false)).toContain("cannot be undone");
    const folder = deleteWarning("/repo/src", true);
    expect(folder).toContain("folder");
    expect(folder).toContain("everything in it");
  });
});

describe("refreshTargets", () => {
  /** The bug: Refresh re-read the root and nothing under it. */
  it("re-reads every loaded directory, not only the root", () => {
    expect(refreshTargets("/repo", ["/repo", "/repo/src", "/repo/src/lib"])).toEqual([
      "/repo",
      "/repo/src",
      "/repo/src/lib",
    ]);
  });

  it("is just the root when nothing else has been opened", () => {
    expect(refreshTargets("/repo", [])).toEqual(["/repo"]);
    expect(refreshTargets("/repo", ["/repo"])).toEqual(["/repo"]);
  });

  /** The cache outlives a repo switch, so it holds other repos' rows. */
  it("ignores directories belonging to another repo", () => {
    expect(refreshTargets("/repo", ["/other", "/other/src", "/repo/src"])).toEqual([
      "/repo",
      "/repo/src",
    ]);
  });

  /** A sibling whose name merely starts with the root's is not under it. */
  it("does not take a prefix match for a child", () => {
    expect(refreshTargets("/repo", ["/repo-backup/src"])).toEqual(["/repo"]);
  });

  it("orders parents before the directories inside them", () => {
    expect(refreshTargets("/repo", ["/repo/a/b/c", "/repo/a", "/repo/a/b"])).toEqual([
      "/repo",
      "/repo/a",
      "/repo/a/b",
      "/repo/a/b/c",
    ]);
  });
});
