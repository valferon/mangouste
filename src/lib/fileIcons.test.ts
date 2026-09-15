import { describe, expect, it } from "vitest";
import { fileGlyph, FolderIcon, FolderOpenIcon, PlainFileIcon } from "./fileIcons";

describe("fileGlyph", () => {
  it("answers directory before it looks at the name", () => {
    expect(fileGlyph("styles.css", true).Icon).toBe(FolderIcon);
    expect(fileGlyph("styles.css", true).tone).toBe("folder");
  });

  it("opens the folder when the row is expanded", () => {
    expect(fileGlyph("src", true, true).Icon).toBe(FolderOpenIcon);
  });

  it("reads the last extension, not the first", () => {
    expect(fileGlyph("App.test.tsx").tone).toBe("code");
    expect(fileGlyph("index.d.ts").tone).toBe("code");
  });

  it("is case-insensitive", () => {
    expect(fileGlyph("README.MD").tone).toBe("doc");
    expect(fileGlyph("Cargo.TOML").tone).toBe("data");
  });

  it("lets a known name beat its extension", () => {
    expect(fileGlyph("package.json").tone).toBe("data");
    expect(fileGlyph("package-lock.json").tone).toBe("locked");
    expect(fileGlyph("Cargo.lock").tone).toBe("locked");
  });

  it("treats a leading dot as a name, not an extension", () => {
    expect(fileGlyph(".gitignore").tone).toBe("data");
    expect(fileGlyph(".unknownrc").Icon).toBe(PlainFileIcon);
  });

  it("falls back to a bare page", () => {
    expect(fileGlyph("mystery").Icon).toBe(PlainFileIcon);
    expect(fileGlyph("mystery.qqq").tone).toBe("plain");
  });

  it("groups systems languages away from scripting ones", () => {
    expect(fileGlyph("lib.rs").tone).toBe("systems");
    expect(fileGlyph("main.go").tone).toBe("systems");
    expect(fileGlyph("build.sh").tone).toBe("script");
  });
});
