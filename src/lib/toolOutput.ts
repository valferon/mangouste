/**
 * What a tool's raw result is, so the chat can render it as that rather than as
 * a wall of text.
 *
 * Everything here is a guess from the bytes and the call that produced them, so
 * every guess errs towards "plain": a wrong colouring misleads in a way that no
 * colouring never does. The decisions are pure functions over strings so they
 * can be tested without a DOM.
 */

import type { ToolResultBlock } from "./types";

/* ---------- Read ---------- */

export interface NumberedLine {
  number: number;
  text: string;
}

export interface NumberedText {
  lines: NumberedLine[];
  /** Whatever followed the numbered run — a system reminder, a truncation note. */
  trailer: string | null;
}

/**
 * `Read`'s result: `cat -n` style, `N<tab>line`. Older CLIs wrote `N→line`.
 *
 * Null unless the very first line is numbered — an error, an image, a notebook
 * dump have their own shapes and are shown as they came.
 */
export function parseNumberedLines(text: string): NumberedText | null {
  const raw = text.split("\n");
  const lines: NumberedLine[] = [];
  let index = 0;
  for (; index < raw.length; index += 1) {
    const match = /^\s*(\d+)(?:\t|→)(.*)$/.exec(raw[index]);
    if (!match) break;
    lines.push({ number: Number(match[1]), text: match[2] });
  }
  if (lines.length === 0) return null;
  const rest = raw.slice(index).join("\n").trim();
  return { lines, trailer: rest === "" ? null : rest };
}

/* ---------- everything else ---------- */

export type OutputShape =
  | { kind: "diff"; text: string }
  | { kind: "code"; language: string; text: string }
  | { kind: "plain"; text: string };

export interface ClassifiedOutput {
  shape: OutputShape;
  /** A note the CLI appended after the command's own output. */
  trailer: string | null;
}

/** Line the CLI appends to a Bash result whose `cd` did not stick. */
const CWD_RESET = /^Shell cwd was reset to /;

/** Peel the CLI's own trailer off a result so it is not mistaken for output. */
export function splitTrailer(text: string): { body: string; trailer: string | null } {
  const trimmed = text.replace(/\s+$/, "");
  const cut = trimmed.lastIndexOf("\n");
  const last = trimmed.slice(cut + 1);
  if (!CWD_RESET.test(last)) return { body: text, trailer: null };
  return { body: cut === -1 ? "" : trimmed.slice(0, cut), trailer: last };
}

/** A `git diff`, or a `diff -u`: a file header pair with a hunk, or git's own header. */
export function looksLikeDiff(text: string): boolean {
  if (/^diff --git /m.test(text)) return true;
  return /^--- /m.test(text) && /^\+\+\+ /m.test(text) && /^@@ /m.test(text);
}

/** Inputs past this are not parsed as JSON; a pretty-print would be unreadable anyway. */
const JSON_SNIFF_MAX = 200_000;

/**
 * The result as JSON, pretty-printed when it arrived on one line, or null.
 *
 * MCP servers answer in JSON and almost always minified; two hundred kilobytes
 * on one line is not something anyone reads. Multi-line JSON is left exactly as
 * written — it was formatted by something that knew what it wanted.
 */
export function asJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > JSON_SNIFF_MAX) return null;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return trimmed.includes("\n") ? trimmed : JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

/**
 * Decide how a tool result should be shown.
 *
 * Only exact structure counts: a `git diff` is a diff whatever command produced
 * it, JSON is JSON whichever server answered. Nothing here guesses a language
 * from a shell command or from the look of the bytes — the CLI and the VS Code
 * extension both show a Bash result as plain text, and a colouring that comes
 * and goes between two similar commands reads as a bug, not as help.
 */
export function classifyOutput(text: string): ClassifiedOutput {
  const { body, trailer } = splitTrailer(text);
  if (looksLikeDiff(body)) return { shape: { kind: "diff", text: body }, trailer };
  const json = asJson(body);
  if (json !== null) return { shape: { kind: "code", language: "json", text: json }, trailer };
  return { shape: { kind: "plain", text: body }, trailer };
}

/* ---------- live results ---------- */

/** Flatten a tool_result payload to displayable text. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof part === "object" && part && "text" in part
            ? String((part as { text: unknown }).text)
            : JSON.stringify(part),
      )
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content, null, 2);
}

export type ToolResults = Record<string, { text: string; isError: boolean }>;

/**
 * Fold live results into the map, dropping the oldest past `max`.
 *
 * Insertion order is age order here: tool ids are never integer-like keys, so
 * the object keeps them in the order they arrived.
 */
export function mergeToolResults(
  current: ToolResults,
  results: ToolResultBlock[],
  max: number,
): ToolResults {
  const next = { ...current };
  for (const result of results) {
    next[result.tool_use_id] = {
      text: toolResultText(result.content),
      isError: Boolean(result.is_error),
    };
  }
  const keys = Object.keys(next);
  if (keys.length <= max) return next;
  for (const key of keys.slice(0, keys.length - max)) delete next[key];
  return next;
}
