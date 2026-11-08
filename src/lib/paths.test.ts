import { describe, expect, it } from "vitest";
import { ancestorsWithin, baseName, parentDir, relativePath, resolvePath } from "./paths";

describe("baseName", () => {
  it("takes the last segment", () => {
    expect(baseName("/home/val/workspace/mangouste/README.md")).toBe("README.md");
  });

  it("returns a bare name unchanged", () => {
    expect(baseName("README.md")).toBe("README.md");
  });

  it("falls back to the whole path rather than returning nothing", () => {
    // A trailing slash would otherwise give "", which reads as a missing file
    // in a menu header or a tab label.
    expect(baseName("/home/val/")).toBe("/home/val/");
    expect(baseName("/")).toBe("/");
  });
});

describe("parentDir", () => {
  it("drops the last segment", () => {
    expect(parentDir("/home/val/notes.md")).toBe("/home/val");
  });

  it("has nothing above a bare name", () => {
    expect(parentDir("notes.md")).toBe("");
  });

  it("has nothing above a root-level entry", () => {
    // Not "/": the caller uses "" to disable "Reveal Containing Folder", and
    // revealing the filesystem root is not what anyone meant.
    expect(parentDir("/notes.md")).toBe("");
  });
});

describe("relativePath", () => {
  const root = "/home/val/workspace/mangouste";

  it("strips the root and its separator", () => {
    expect(relativePath(root, `${root}/src/App.tsx`)).toBe("src/App.tsx");
  });

  it("tolerates a root that already ends in a separator", () => {
    expect(relativePath(`${root}/`, `${root}/src/App.tsx`)).toBe("src/App.tsx");
  });

  it("returns the absolute path for a file outside the root", () => {
    expect(relativePath(root, "/etc/hosts")).toBe("/etc/hosts");
  });

  it("does not treat a sibling with a shared prefix as inside", () => {
    // The separator in the prefix is what stops "mangouste-old" matching
    // "mangouste" — a plain startsWith would mangle it to "-old/src/App.tsx".
    expect(relativePath(root, `${root}-old/src/App.tsx`)).toBe(`${root}-old/src/App.tsx`);
  });

  it("passes the path through when there is no root yet", () => {
    // Before a repo is chosen, activeRepo is "".
    expect(relativePath("", "/etc/hosts")).toBe("/etc/hosts");
  });
});

describe("resolvePath", () => {
  it("joins a relative path onto the base", () => {
    expect(resolvePath("/repo", "src/lib/ipc.ts")).toBe("/repo/src/lib/ipc.ts");
    expect(resolvePath("/repo/", "README.md")).toBe("/repo/README.md");
  });

  it("folds dot segments", () => {
    expect(resolvePath("/repo/sub", "./a/../b.ts")).toBe("/repo/sub/b.ts");
    expect(resolvePath("/repo/sub", "../other/x.md")).toBe("/repo/other/x.md");
  });

  it("leaves an absolute path where it is", () => {
    expect(resolvePath("/repo", "/etc/hosts")).toBe("/etc/hosts");
    expect(resolvePath("/repo", "/a/./b/../c")).toBe("/a/c");
  });

  it("does not climb past the root", () => {
    expect(resolvePath("/repo", "../../../x")).toBe("/x");
  });
});

describe("ancestorsWithin", () => {
  it("lists the folders between root and file, outermost first", () => {
    expect(ancestorsWithin("/repo", "/repo/src/lib/ipc.ts")).toEqual(["/repo/src", "/repo/src/lib"]);
  });

  it("is empty for a file at the root or outside it", () => {
    expect(ancestorsWithin("/repo", "/repo/README.md")).toEqual([]);
    expect(ancestorsWithin("/repo", "/elsewhere/x.ts")).toEqual([]);
    expect(ancestorsWithin("/repo", "/repository/x.ts")).toEqual([]);
  });
});
