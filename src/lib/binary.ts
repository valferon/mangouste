/**
 * What to show for a file the text editor refuses to open.
 *
 * The editor's rule is one byte wide — a NUL anywhere and the file is not text —
 * which is right for editing and useless as an answer. A PNG, a PDF and a
 * firmware blob all fail the same test and none of them wants the same
 * treatment, so the choice of preview is made here, from the name, and the
 * viewer only draws what it is handed.
 */

/** How a binary file is worth showing. */
export type PreviewKind =
  /** Drawn in an `<img>` from a data URI. */
  | { kind: "image"; mime: string }
  /** Bytes in three columns, for anything with no better rendering. */
  | { kind: "hex" }
  /** Nothing useful in-app; the desktop has an application for this. */
  | { kind: "external"; what: string };

/**
 * Image types the webview can decode itself.
 *
 * Deliberately short: an `<img>` that cannot decode its source renders as
 * nothing at all, with no error to catch, so a format that is only sometimes
 * supported is worse here than one that was never offered. TIFF and HEIC are
 * the ones this leaves out on purpose.
 */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

/**
 * Formats the desktop opens better than we can, with the name to say so by.
 *
 * PDF is on this list rather than rendered inline because the webview has no
 * PDF viewer of its own on Linux — an `<embed>` there is a blank rectangle, and
 * bundling one is a megabyte of vendored JavaScript for a file type every
 * desktop already handles. Office documents are zip containers whose text could
 * be extracted, but the extraction is not the document.
 */
const EXTERNAL_KIND: Record<string, string> = {
  pdf: "PDF",
  doc: "Word document",
  docx: "Word document",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  ppt: "presentation",
  pptx: "presentation",
  odt: "document",
  ods: "spreadsheet",
  odp: "presentation",
  rtf: "document",
  epub: "e-book",
  mp3: "audio file",
  wav: "audio file",
  flac: "audio file",
  ogg: "audio file",
  m4a: "audio file",
  mp4: "video file",
  mov: "video file",
  mkv: "video file",
  webm: "video file",
  avi: "video file",
  zip: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
  xz: "archive",
  zst: "archive",
  "7z": "archive",
  rar: "archive",
  tar: "archive",
};

/** Lowercased extension of a path, or "" when it has none worth the name. */
export function extensionOf(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  // A leading dot is a whole name, not an extension: `.gitignore` is not a file
  // of type `gitignore`. Hence `> 0` rather than `>= 0`.
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

/** Which preview a path earns. Falls back to hex, which always says something. */
export function previewFor(path: string): PreviewKind {
  const extension = extensionOf(path);
  const mime = IMAGE_MIME[extension];
  if (mime) return { kind: "image", mime };
  const what = EXTERNAL_KIND[extension];
  if (what) return { kind: "external", what };
  return { kind: "hex" };
}

/** Base64 to bytes, the pair of `TerminalPane`'s encoder. */
export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Bytes per hex-dump row. Sixteen is what every other dumper prints. */
export const HEX_ROW = 16;

/** One row of a dump: an offset, the bytes, and what they say as characters. */
export interface HexRow {
  /** Byte offset of the row's first byte, zero-padded to eight hex digits. */
  offset: string;
  /** `HEX_ROW` two-digit values, short on the last row of a file. */
  bytes: string[];
  /** The same bytes as printable ASCII, with `.` standing in for the rest. */
  text: string;
}

/**
 * Rows of a hex dump, at most `limit` of them.
 *
 * Returns rows rather than a formatted string because the columns are aligned
 * by CSS and not by padding: a monospace `<pre>` of a megabyte is one text node
 * the browser lays out in full, where rows can be windowed by the caller.
 */
export function hexRows(bytes: Uint8Array, limit = Infinity): HexRow[] {
  const rows: HexRow[] = [];
  for (let start = 0; start < bytes.length && rows.length < limit; start += HEX_ROW) {
    const slice = bytes.subarray(start, start + HEX_ROW);
    const values: string[] = [];
    let text = "";
    for (const byte of slice) {
      values.push(byte.toString(16).padStart(2, "0"));
      // Printable ASCII only. A byte above 0x7e is either a control code or
      // half of something multi-byte, and guessing which one turns a dump into
      // a bad decoder.
      text += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
    }
    rows.push({
      offset: start.toString(16).padStart(8, "0"),
      bytes: values,
      text,
    });
  }
  return rows;
}

/** A byte count as a person would say it. */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below ten, none above: `1.4 MB` reads, `847.3 KB` is noise.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
