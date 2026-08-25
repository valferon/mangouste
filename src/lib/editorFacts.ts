/**
 * What the right-hand end of the status bar says about the file being edited.
 *
 * Caret position, line endings, indentation and language — the row VSCode keeps
 * there. All of it belongs to the editor, and the status bar is somewhere else
 * entirely, so it travels through a module store rather than through `App`.
 *
 * That is the whole reason this file exists. Caret position changes on every
 * keystroke, and routing it through `App` state would re-render the workbench
 * once per character typed. Published here instead, the only thing that re-reads
 * is the one status-bar item that shows it — the same trade `debugLog` makes,
 * and the same `useSyncExternalStore` shape.
 */

import { languageForPath } from "./highlight";

/** Line endings, named as editors name them. */
export type Eol = "LF" | "CRLF";

export interface Indent {
  kind: "spaces" | "tabs";
  size: number;
}

export interface EditorFacts {
  /** Which file these are about, so a stale pane cannot clear a live one's. */
  path: string;
  /** 1-based, as every editor counts them and nothing else does. */
  line: number;
  column: number;
  eol: Eol;
  indent: Indent;
  /** Display name, e.g. `TypeScript`. `Plain Text` when nothing claims it. */
  language: string;
}

/** Caret offset to the line and column an editor would show for it. */
export function caretAt(text: string, offset: number): { line: number; column: number } {
  const at = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < at; i += 1) {
    if (text[i] === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  // Columns count characters, so a CRLF's `\r` is not one of them: a caret at
  // the end of a CRLF line would otherwise read one past where it looks.
  let column = at - lineStart + 1;
  if (column > 1 && text[at - 1] === "\r") column -= 1;
  return { line, column };
}

/**
 * Which line ending the file uses.
 *
 * The first one found decides. A file with both is mixed, and calling it by
 * whichever appears more often would be a number nobody can act on — the first
 * is at least the one the next line will probably use.
 */
export function detectEol(text: string): Eol {
  const newline = text.indexOf("\n");
  if (newline <= 0) return "LF";
  return text[newline - 1] === "\r" ? "CRLF" : "LF";
}

/** How many lines are examined before guessing. Enough for a header and some code. */
const INDENT_SAMPLE_LINES = 200;

/**
 * The file's own indentation, guessed the way an editor guesses it.
 *
 * A tab anywhere in a leading run settles it. Otherwise the *smallest* positive
 * space indent wins, not the first one: a file whose first indented line happens
 * to be three levels deep would otherwise be reported as indenting by six.
 */
export function detectIndent(text: string): Indent {
  const lines = text.split("\n", INDENT_SAMPLE_LINES);
  let smallest = 0;
  for (const line of lines) {
    const run = /^[ \t]+/.exec(line);
    if (!run) continue;
    // A line of pure whitespace says nothing about how code is indented.
    if (run[0].length === line.length) continue;
    if (run[0].includes("\t")) return { kind: "tabs", size: 4 };
    const width = run[0].length;
    if (smallest === 0 || width < smallest) smallest = width;
  }
  return { kind: "spaces", size: smallest === 0 ? 2 : smallest };
}

/** `Spaces: 2` / `Tab Size: 4`, as VSCode labels them. */
export function describeIndent(indent: Indent): string {
  return indent.kind === "tabs" ? `Tab Size: ${indent.size}` : `Spaces: ${indent.size}`;
}

/**
 * Display names for the highlighter's ids.
 *
 * `languageForPath` mostly hands back the extension itself — lowlight registers
 * `ts`, `md`, `py` and friends as aliases — so these are keyed on what actually
 * arrives, short ids and canonical names alike. Anything unlisted falls through
 * to capitalising the id, which is right far more often than it is wrong.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  bash: "Shell Script",
  c: "C",
  cc: "C++",
  cpp: "C++",
  cs: "C#",
  csharp: "C#",
  css: "CSS",
  diff: "Diff",
  dockerfile: "Docker",
  go: "Go",
  graphql: "GraphQL",
  h: "C",
  hpp: "C++",
  htm: "HTML",
  html: "HTML",
  ini: "INI",
  java: "Java",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  jsonc: "JSON with Comments",
  jsx: "JavaScript React",
  kt: "Kotlin",
  kotlin: "Kotlin",
  less: "Less",
  lua: "Lua",
  makefile: "Makefile",
  md: "Markdown",
  markdown: "Markdown",
  mjs: "JavaScript",
  nix: "Nix",
  objectivec: "Objective-C",
  php: "PHP",
  pl: "Perl",
  plaintext: "Plain Text",
  py: "Python",
  python: "Python",
  rb: "Ruby",
  rs: "Rust",
  ruby: "Ruby",
  rust: "Rust",
  scss: "SCSS",
  sh: "Shell Script",
  sql: "SQL",
  swift: "Swift",
  toml: "TOML",
  ts: "TypeScript",
  tsx: "TypeScript React",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
  zsh: "Shell Script",
};

export function languageName(path: string): string {
  const id = languageForPath(path);
  if (!id) return "Plain Text";
  return LANGUAGE_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** Everything the status bar needs, derived in one pass over the buffer. */
export function factsFor(path: string, text: string, caret: number): EditorFacts {
  const { line, column } = caretAt(text, caret);
  return {
    path,
    line,
    column,
    eol: detectEol(text),
    indent: detectIndent(text),
    language: languageName(path),
  };
}

/* ---------- the store ----------
 *
 * A version counter as the snapshot, with consumers reading the value directly:
 * `useSyncExternalStore` demands a stable snapshot, and an object rebuilt per
 * keystroke is the opposite of one.
 */

let current: EditorFacts | null = null;
let version = 0;
const listeners = new Set<() => void>();

function announce(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function publishEditorFacts(facts: EditorFacts): void {
  current = facts;
  announce();
}

/**
 * Drop the facts, but only if they are still this file's.
 *
 * Two editors changing places both fire: the one going hidden clears and the one
 * coming forward publishes, in whichever order React runs them. Without the
 * check, a clear landing second would blank the row for the file now in front.
 */
export function clearEditorFacts(path: string): void {
  if (current?.path !== path) return;
  current = null;
  announce();
}

export function subscribeEditorFacts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function editorFactsVersion(): number {
  return version;
}

export function currentEditorFacts(): EditorFacts | null {
  return current;
}
