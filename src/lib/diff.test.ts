import { describe, expect, it } from "vitest";
import { diffFileHeaderPath, diffHeaderPath, diffLineClass, diffSide } from "./diff";

describe("diffSide", () => {
  it("assigns content lines to a side", () => {
    expect(diffSide(" context")).toBe("both");
    expect(diffSide("+added")).toBe("new");
    expect(diffSide("-removed")).toBe("old");
  });

  it("keeps headers and blanks out of both sides", () => {
    expect(diffSide("+++ b/x.ts")).toBe("none");
    expect(diffSide("--- a/x.ts")).toBe("none");
    expect(diffSide("@@ -1,2 +1,3 @@")).toBe("none");
    expect(diffSide("diff --git a/x b/x")).toBe("none");
    expect(diffSide("index 1..2 100644")).toBe("none");
    expect(diffSide("\\ No newline at end of file")).toBe("none");
    expect(diffSide("")).toBe("none");
  });

  it("agrees with the colouriser about what is content", () => {
    for (const line of ["+a", "-a", " a", "+++ a", "--- a", "@@ x", "diff --git a b", "index 1"]) {
      const painted = diffLineClass(line);
      const side = diffSide(line);
      expect(painted === "diff-add").toBe(side === "new");
      expect(painted === "diff-del").toBe(side === "old");
    }
  });
});

describe("header paths", () => {
  it("prefers the post-image, falls back to the pre-image on delete", () => {
    expect(diffHeaderPath("diff --git a/src/a.ts b/src/a.ts")).toBe("src/a.ts");
    expect(diffHeaderPath("diff --git a/old.ts b/new.ts")).toBe("new.ts");
    expect(diffHeaderPath("diff --git a/gone.ts b/dev/null")).toBe("gone.ts");
    expect(diffHeaderPath("not a header")).toBeNull();
  });

  it("reads +++/--- headers with and without git prefixes", () => {
    expect(diffFileHeaderPath("+++ b/src/a.ts")).toBe("src/a.ts");
    expect(diffFileHeaderPath("--- a/src/a.ts")).toBe("src/a.ts");
    expect(diffFileHeaderPath("+++ src/a.ts\t2026-08-26 10:00:00")).toBe("src/a.ts");
    expect(diffFileHeaderPath("--- /dev/null")).toBeNull();
    expect(diffFileHeaderPath("+added line")).toBeNull();
  });
});
