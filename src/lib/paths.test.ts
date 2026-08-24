import { describe, expect, it } from "vitest";
import { baseName, parentDir, relativePath } from "./paths";

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
