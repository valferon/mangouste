import { describe, expect, it } from "vitest";

import { extensionOf, formatBytes, hexRows, previewFor } from "./binary";

describe("extensionOf", () => {
  it("lowercases and ignores the directory", () => {
    expect(extensionOf("/a/b/Photo.PNG")).toBe("png");
    expect(extensionOf("C:\\docs\\Report.PDF")).toBe("pdf");
  });

  it("takes the last extension, not the first", () => {
    expect(extensionOf("archive.tar.gz")).toBe("gz");
  });

  it("gives nothing for a dotfile or a name with no dot", () => {
    expect(extensionOf("/repo/.gitignore")).toBe("");
    expect(extensionOf("/usr/bin/ls")).toBe("");
  });
});

describe("previewFor", () => {
  it("draws an image the webview can decode", () => {
    expect(previewFor("logo.png")).toEqual({
      kind: "image",
      mime: "image/png",
    });
    expect(previewFor("shot.JPEG")).toEqual({
      kind: "image",
      mime: "image/jpeg",
    });
  });

  it("sends a document to the desktop", () => {
    expect(previewFor("/tmp/notes.docx")).toEqual({
      kind: "external",
      what: "Word document",
    });
    expect(previewFor("/tmp/cert.pdf")).toEqual({
      kind: "external",
      what: "PDF",
    });
  });

  it("falls back to hex for anything unrecognised", () => {
    expect(previewFor("firmware.bin")).toEqual({ kind: "hex" });
    expect(previewFor("/usr/bin/ls")).toEqual({ kind: "hex" });
  });

  it("does not offer an inline image for a format the webview may not decode", () => {
    expect(previewFor("scan.tiff")).toEqual({ kind: "hex" });
  });
});

describe("hexRows", () => {
  it("splits into rows of sixteen with a padded offset", () => {
    const bytes = new Uint8Array(20).map((_, index) => index);
    const rows = hexRows(bytes);
    expect(rows).toHaveLength(2);
    expect(rows[0].offset).toBe("00000000");
    expect(rows[1].offset).toBe("00000010");
    expect(rows[0].bytes).toHaveLength(16);
    // The tail row is short rather than padded out: the columns are laid out by
    // CSS, so a filler byte would be a byte the file does not have.
    expect(rows[1].bytes).toEqual(["10", "11", "12", "13"]);
  });

  it("shows printable ASCII and stands in for the rest", () => {
    const bytes = new Uint8Array([0x68, 0x69, 0x00, 0x0a, 0xff, 0x7e]);
    expect(hexRows(bytes)[0].text).toBe("hi...~");
    expect(hexRows(bytes)[0].bytes).toEqual(["68", "69", "00", "0a", "ff", "7e"]);
  });

  it("stops at the row limit", () => {
    expect(hexRows(new Uint8Array(1024), 3)).toHaveLength(3);
  });

  it("has no rows for an empty file", () => {
    expect(hexRows(new Uint8Array())).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("counts bytes below a kilobyte", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("keeps one decimal below ten and drops it above", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 847)).toBe("847 KB");
    expect(formatBytes(1024 * 1024 * 3.25)).toBe("3.3 MB");
  });

  it("stops climbing at terabytes", () => {
    expect(formatBytes(1024 ** 5)).toBe("1024 TB");
  });
});
