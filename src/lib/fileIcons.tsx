import type { SVGProps } from "react";

/**
 * File-type glyphs for the explorer and the source-control list.
 *
 * Drawn here rather than in `icons.tsx` because these are chosen by a lookup
 * rather than named at the call site, and because the tone that goes with each
 * one is part of the same decision — a glyph and its colour together are what
 * makes a tree readable at a glance, and splitting them across two modules is
 * how they drift apart.
 *
 * Tones are theme accent aliases, not brand hexes: TypeScript blue baked in
 * would be the only thing on screen that does not move when the theme does, and
 * would sit badly on the light palettes. See `--file-*` in `styles.css`.
 */
type IconProps = SVGProps<SVGSVGElement>;

/** Every tone a row can take. One CSS custom property each. */
export type FileTone =
  | "code"
  | "data"
  | "doc"
  | "style"
  | "systems"
  | "script"
  | "media"
  | "locked"
  | "plain"
  | "folder";

function Glyph({ children, className, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ? `icon ${className}` : "icon"}
      {...rest}
    >
      {children}
    </svg>
  );
}

/** The page every file glyph is drawn on, with its corner turned down. */
const SHEET = (
  <>
    <path d="M9 1.8H4.4a1.1 1.1 0 0 0-1.1 1.1v10.2a1.1 1.1 0 0 0 1.1 1.1h7.2a1.1 1.1 0 0 0 1.1-1.1V5.6Z" />
    <path d="M9 1.8v3.8h3.7" />
  </>
);

export function FolderIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M1.7 12.6V3.6a.9.9 0 0 1 .9-.9h3.1l1.5 1.8h6.1a.9.9 0 0 1 .9.9v7.2a.9.9 0 0 1-.9.9H2.6a.9.9 0 0 1-.9-.9Z" />
    </Glyph>
  );
}

export function FolderOpenIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M1.7 12.6V3.6a.9.9 0 0 1 .9-.9h3.1l1.5 1.8h6.1a.9.9 0 0 1 .9.9v1.3" />
      <path d="M1.7 12.6 3.6 7.2a.9.9 0 0 1 .85-.6h9.9a.6.6 0 0 1 .57.8l-1.6 4.6a.9.9 0 0 1-.85.6Z" />
    </Glyph>
  );
}

/** Source: the angle brackets an editor puts on anything it can parse. */
export function CodeFileIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      {SHEET}
      <path d="M6.6 8.2 5.2 9.7l1.4 1.5" />
      <path d="M9.4 8.2l1.4 1.5-1.4 1.5" />
    </Glyph>
  );
}

/** Structured data: braces, the shape every config format collapses to. */
export function DataFileIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      {SHEET}
      <path d="M6.9 7.9c-.9 0-.9.9-.9 1.7s0 1.7-.8 1.7c.8 0 .8.9.8 1.4" />
      <path d="M9.1 7.9c.9 0 .9.9.9 1.7s0 1.7.8 1.7c-.8 0-.8.9-.8 1.4" />
    </Glyph>
  );
}

/** Prose: ruled lines, the last one short the way a paragraph ends. */
export function DocFileIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      {SHEET}
      <path d="M5.5 8.6h5" />
      <path d="M5.5 10.6h5" />
      <path d="M5.5 12.6h2.6" />
    </Glyph>
  );
}

/** Stylesheets and markup: a drop of paint. A `#` was the first draft and it
    silted up into a blob — four strokes inside a 6px box is not a glyph. */
export function StyleFileIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      {SHEET}
      <path d="M8 8.1c1.7 1.8 2.6 3 2.6 4.1a2.6 2.6 0 0 1-5.2 0c0-1.1.9-2.3 2.6-4.1Z" />
    </Glyph>
  );
}

/** Systems languages: a hex nut, for the layer that gets built rather than run.
    A cog was the first draft; its teeth vanished into a smudge at 14px. */
export function SystemsFileIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      {SHEET}
      <path d="M8 8.2 10.4 9.6v2.8L8 13.8l-2.4-1.4V9.6Z" />
    </Glyph>
  );
}

/** Anything a shell runs: the prompt it runs at. */
export function ScriptFileIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      {SHEET}
      <path d="M5.4 8.6 7 10.2l-1.6 1.6" />
      <path d="M8.2 12.4h2.6" />
    </Glyph>
  );
}

/** Images and anything else the viewer paints rather than reads. */
export function MediaFileIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      {SHEET}
      <circle cx="6" cy="9.1" r=".8" />
      <path d="M4.4 12.8 6.4 10.8l1.5 1.5 1.6-1.6 2.1 2.1" />
    </Glyph>
  );
}

/** Lockfiles: generated, and not yours to hand-edit. */
export function LockedFileIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      {SHEET}
      <rect x="5.6" y="10.3" width="4.8" height="3.4" rx=".8" />
      <path d="M6.9 10.3V9.2a1.1 1.1 0 0 1 2.2 0v1.1" />
    </Glyph>
  );
}

/** Everything unrecognised: the bare page. */
export function PlainFileIcon(props: IconProps) {
  return <Glyph {...props}>{SHEET}</Glyph>;
}

interface FileGlyph {
  Icon: (props: IconProps) => React.ReactElement;
  tone: FileTone;
}

/**
 * Extension to glyph. Grouped by what a file *is to the reader* rather than by
 * language: `.ts` and `.py` get the same page of angle brackets because the tree
 * is answering "is this source?", and a per-language glyph at 14px is a smudge
 * that answers it no better.
 */
const BY_EXTENSION: Record<string, FileGlyph> = {};

function register(tone: FileTone, Icon: FileGlyph["Icon"], extensions: string[]) {
  for (const extension of extensions) BY_EXTENSION[extension] = { Icon, tone };
}

register("code", CodeFileIcon, [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py", "rb", "java",
  "kt", "kts", "swift", "php", "cs", "scala", "ex", "exs", "lua", "dart", "vue", "svelte",
]);
register("systems", SystemsFileIcon, ["rs", "go", "c", "h", "cc", "cpp", "hpp", "zig", "wasm"]);
register("data", DataFileIcon, [
  "json", "jsonc", "json5", "toml", "yaml", "yml", "xml", "ini", "cfg", "conf",
  "env", "properties", "csv", "tsv", "sql", "graphql", "gql", "proto",
]);
register("doc", DocFileIcon, ["md", "mdx", "markdown", "txt", "rst", "adoc", "org", "pdf", "tex"]);
register("style", StyleFileIcon, ["css", "scss", "sass", "less", "styl", "html", "htm"]);
register("script", ScriptFileIcon, ["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "mk"]);
register("media", MediaFileIcon, [
  "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp",
  "mp4", "webm", "mov", "mp3", "wav", "ogg", "woff", "woff2", "ttf", "otf",
]);

/** Names that beat their own extension: a lockfile is not the data it holds. */
const BY_NAME: Record<string, FileGlyph> = {
  "package-lock.json": { Icon: LockedFileIcon, tone: "locked" },
  "cargo.lock": { Icon: LockedFileIcon, tone: "locked" },
  "yarn.lock": { Icon: LockedFileIcon, tone: "locked" },
  "pnpm-lock.yaml": { Icon: LockedFileIcon, tone: "locked" },
  "poetry.lock": { Icon: LockedFileIcon, tone: "locked" },
  "go.sum": { Icon: LockedFileIcon, tone: "locked" },
  dockerfile: { Icon: ScriptFileIcon, tone: "script" },
  makefile: { Icon: ScriptFileIcon, tone: "script" },
  license: { Icon: DocFileIcon, tone: "doc" },
  ".gitignore": { Icon: DataFileIcon, tone: "data" },
  ".gitattributes": { Icon: DataFileIcon, tone: "data" },
  ".editorconfig": { Icon: DataFileIcon, tone: "data" },
};

/**
 * The glyph and tone for one tree row.
 *
 * Directories answer first and ignore their name: a folder called `styles.css`
 * is still a folder, and the tree has to say so before it says anything else.
 */
export function fileGlyph(name: string, isDir = false, isOpen = false): FileGlyph {
  if (isDir) return { Icon: isOpen ? FolderOpenIcon : FolderIcon, tone: "folder" };

  const lower = name.toLowerCase();
  const exact = BY_NAME[lower];
  if (exact) return exact;

  // Last dot only: `App.test.tsx` is a `.tsx`, and `.gitignore` — leading dot,
  // nothing before it — has no extension at all and falls through to the name
  // table above or to the bare page.
  const dot = lower.lastIndexOf(".");
  if (dot > 0) {
    const found = BY_EXTENSION[lower.slice(dot + 1)];
    if (found) return found;
  }
  return { Icon: PlainFileIcon, tone: "plain" };
}
