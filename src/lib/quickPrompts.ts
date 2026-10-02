/**
 * Quick prompts: saved messages a rail button drops into the session in front.
 *
 * Text the same few requests keep needing ("commit and push", "tidy my mail")
 * typed once and replayed with a click. The list is a preference, so it is
 * shared by every window, and its reads go through the same validation as the
 * rest of the store: one hand-edited or half-written entry costs that entry,
 * never the list.
 */

import { KEYS, readJson, writeJson } from "./persist";

export interface QuickPrompt {
  id: string;
  /** What the button says. Never empty: a blank one is derived from `text`. */
  label: string;
  /** What lands in the composer. */
  text: string;
  /** Send straight away rather than leave it in the composer to read first. */
  submit: boolean;
}

/** What the editor hands back; the id is the list's business. */
export type QuickPromptDraft = Omit<QuickPrompt, "id">;

export const PROMPTS_KEY = KEYS.prefs.quickPrompts;

/** A button label is one line, and short enough to stay a button. */
const LABEL_MAX = 80;

/** The label a prompt gets when none was typed: its first non-blank line. */
export function deriveLabel(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  const trimmed = line.trim();
  return trimmed.length > LABEL_MAX ? `${trimmed.slice(0, LABEL_MAX - 1)}…` : trimmed;
}

function isPrompt(value: unknown): value is QuickPrompt {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    entry.id !== "" &&
    typeof entry.label === "string" &&
    typeof entry.text === "string" &&
    entry.text.trim() !== "" &&
    typeof entry.submit === "boolean"
  );
}

/**
 * Keep the entries that are prompts, once each.
 *
 * A repeated id would make two rows that edit and delete as one, so the second
 * of a pair is dropped rather than trusted.
 */
export function cleanPrompts(value: unknown): QuickPrompt[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const prompts: QuickPrompt[] = [];
  for (const entry of value) {
    if (!isPrompt(entry) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    prompts.push({
      id: entry.id,
      label: entry.label.trim() || deriveLabel(entry.text),
      text: entry.text,
      submit: entry.submit,
    });
  }
  return prompts;
}

export function readPrompts(): QuickPrompt[] {
  return cleanPrompts(readJson<unknown>(PROMPTS_KEY, [], Array.isArray));
}

export function writePrompts(prompts: readonly QuickPrompt[]): void {
  writeJson(PROMPTS_KEY, prompts);
}

/** Normalise what the editor produced. Null when there is nothing to save. */
export function normaliseDraft(draft: QuickPromptDraft): QuickPromptDraft | null {
  if (draft.text.trim() === "") return null;
  return {
    label: draft.label.trim() || deriveLabel(draft.text),
    text: draft.text,
    submit: draft.submit,
  };
}

export function addPrompt(
  prompts: readonly QuickPrompt[],
  draft: QuickPromptDraft,
  id: string,
): QuickPrompt[] {
  const clean = normaliseDraft(draft);
  return clean ? [...prompts, { id, ...clean }] : [...prompts];
}

export function updatePrompt(
  prompts: readonly QuickPrompt[],
  id: string,
  draft: QuickPromptDraft,
): QuickPrompt[] {
  const clean = normaliseDraft(draft);
  if (!clean) return [...prompts];
  return prompts.map((prompt) => (prompt.id === id ? { id, ...clean } : prompt));
}

export function removePrompt(prompts: readonly QuickPrompt[], id: string): QuickPrompt[] {
  return prompts.filter((prompt) => prompt.id !== id);
}

/** Swap a prompt with its neighbour. Off either end is a no-op, not a wrap. */
export function movePrompt(
  prompts: readonly QuickPrompt[],
  id: string,
  delta: -1 | 1,
): QuickPrompt[] {
  const from = prompts.findIndex((prompt) => prompt.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= prompts.length) return [...prompts];
  const next = [...prompts];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/**
 * Where a prompt lands in a composer that already holds a draft.
 *
 * Appended on a line of its own rather than replacing: a click must never be
 * the thing that throws away half a message.
 */
export function appendToDraft(draft: string, text: string): string {
  if (draft.trim() === "") return text;
  return `${draft.replace(/\s+$/, "")}\n${text}`;
}

/**
 * A prompt on its way into one pane.
 *
 * `token` is what makes it a request rather than a value: the same prompt
 * clicked twice is two pastes, and a pane re-rendering with a request it has
 * already served must not paste it again.
 */
export interface PasteRequest {
  token: number;
  text: string;
  submit: boolean;
}
