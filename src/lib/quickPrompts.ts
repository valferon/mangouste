/**
 * Quick prompts: saved messages a rail button drops into the session in front.
 *
 * Text the same few requests keep needing ("commit and push", "tidy my mail")
 * typed once and replayed with a click. The list is a preference, so it is
 * shared by every window, and its reads go through the same validation as the
 * rest of the store: one hand-edited or half-written entry costs that entry,
 * never the list.
 */

import { parseCron } from "./cron";
import { KEYS, readJson, writeJson } from "./persist";

export interface QuickPrompt {
  id: string;
  /** What the button says. Never empty: a blank one is derived from `text`. */
  label: string;
  /** What lands in the composer. */
  text: string;
  /** Send straight away rather than leave it in the composer to read first. */
  submit: boolean;
  /** Always open a fresh session for it, rather than use the one in front. */
  newSession: boolean;
  /**
   * The repo that fresh session opens in. Null is "whichever repo is active",
   * and only means anything with `newSession`.
   */
  project: string | null;
  /**
   * Cron expression to run it on, while the app is open. A scheduled prompt is
   * always a new session that sends: at 3am there is no "session in front"
   * worth trusting, and nobody there to press Enter.
   */
  schedule: string | null;
  /**
   * A one-off run time, as an ISO timestamp. Fired once and then removed, and,
   * unlike a cron run, fired late when it came due while the app was closed: a
   * follow-up somebody asked for is still wanted an hour after its minute.
   * Ignored when `schedule` is set.
   */
  at: string | null;
  /**
   * The session a timed run goes to, by uuid, instead of a fresh one: a
   * follow-up in the conversation that asked for it. Null is a new session in
   * `project`.
   */
  session: string | null;
  /**
   * Who scheduled it, when a session did: its uuid, or `outside` for
   * `mangouste --mcp`. Null for a prompt made in the Prompts view. Sessions
   * can list and cancel only the prompts they made (see `sessionControl.ts`).
   */
  origin: string | null;
}

/** Which of the pane's lists a prompt sits in. Also what reordering respects. */
export type PromptGroup = "here" | "new" | "scheduled";

export function groupOf(prompt: QuickPrompt): PromptGroup {
  if (isTimed(prompt)) return "scheduled";
  return prompt.newSession ? "new" : "here";
}

/** Runs on its own, from the schedule clock, rather than only on a click. */
export function isTimed(prompt: Pick<QuickPrompt, "schedule" | "at">): boolean {
  return prompt.schedule !== null || prompt.at !== null;
}

/** An ISO timestamp that names a real instant. */
export function isInstant(value: string): boolean {
  return value.trim() !== "" && !Number.isNaN(Date.parse(value));
}

/** One-off prompts whose time has come, oldest first. */
export function dueOneOffs(prompts: readonly QuickPrompt[], now: Date): QuickPrompt[] {
  return prompts
    .filter((prompt) => prompt.schedule === null && prompt.at !== null)
    .filter((prompt) => Date.parse(prompt.at!) <= now.getTime())
    .sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!));
}

/**
 * Fired when this window writes the list. `storage` only reaches the *other*
 * windows, and the list is now also written from outside the pane (a session
 * scheduling a follow-up, a one-off removing itself once it has run).
 */
export const PROMPTS_CHANGED_EVENT = "mangouste:prompts-changed";

/** What the editor hands back; the id is the list's business. */
export type QuickPromptDraft = Omit<QuickPrompt, "id">;

export const PROMPTS_KEY = KEYS.prefs.quickPrompts;

export const newPromptId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

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
    typeof entry.submit === "boolean" &&
    // Added after the first release: absent is the old behaviour, not corrupt.
    (entry.newSession === undefined || typeof entry.newSession === "boolean") &&
    (entry.project === undefined || entry.project === null || typeof entry.project === "string") &&
    (entry.schedule === undefined || entry.schedule === null || typeof entry.schedule === "string") &&
    (entry.at === undefined || entry.at === null || typeof entry.at === "string") &&
    (entry.session === undefined || entry.session === null || typeof entry.session === "string") &&
    (entry.origin === undefined || entry.origin === null || typeof entry.origin === "string")
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
    // A schedule that no longer parses (hand-edited, or from a newer build's
    // syntax) is dropped rather than left to never fire without saying so.
    const schedule = entry.schedule && parseCron(entry.schedule).ok ? entry.schedule.trim() : null;
    const at = !schedule && entry.at && isInstant(entry.at) ? entry.at : null;
    prompts.push({
      id: entry.id,
      label: entry.label.trim() || deriveLabel(entry.text),
      text: entry.text,
      submit: entry.submit,
      newSession: entry.newSession ?? false,
      project: entry.project || null,
      schedule,
      at,
      session: (schedule || at) && entry.session ? entry.session : null,
      origin: entry.origin || null,
    });
  }
  return prompts;
}

export function readPrompts(): QuickPrompt[] {
  return cleanPrompts(readJson<unknown>(PROMPTS_KEY, [], Array.isArray));
}

/** Prompt id to the minute (epoch minutes) its cron last fired. */
export type FiredLedger = Readonly<Record<string, number>>;

const FIRED_KEY = KEYS.prefs.cronFired;

function isLedger(value: unknown): value is FiredLedger {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((minute) => typeof minute === "number")
  );
}

export function readFired(): FiredLedger {
  return readJson<FiredLedger>(FIRED_KEY, {}, isLedger);
}

export function writeFired(ledger: FiredLedger): void {
  writeJson(FIRED_KEY, ledger);
}

/**
 * Claim `minute` for prompt `id`: the ledger to write when it has not fired
 * yet in that minute, or null when it has.
 *
 * Entries for prompts no longer in `liveIds` are dropped on the way, so a
 * deleted prompt does not keep its row forever.
 */
export function claimMinute(
  ledger: FiredLedger,
  id: string,
  minute: number,
  liveIds: ReadonlySet<string>,
): FiredLedger | null {
  if ((ledger[id] ?? -1) >= minute) return null;
  const kept = Object.fromEntries(Object.entries(ledger).filter(([key]) => liveIds.has(key)));
  return { ...kept, [id]: minute };
}

export function writePrompts(prompts: readonly QuickPrompt[]): void {
  writeJson(PROMPTS_KEY, prompts);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PROMPTS_CHANGED_EVENT));
}

/**
 * Normalise what the editor produced. Null when there is nothing to save, or
 * when the schedule does not parse.
 */
export function normaliseDraft(draft: QuickPromptDraft): QuickPromptDraft | null {
  if (draft.text.trim() === "") return null;
  const schedule = draft.schedule?.trim() || null;
  if (schedule && !parseCron(schedule).ok) return null;
  // A cron schedule replaces a one-off time; it never runs alongside one.
  const at = !schedule && draft.at && isInstant(draft.at) ? draft.at : null;
  const timed = schedule !== null || at !== null;
  const newSession = draft.newSession || timed;
  return {
    label: draft.label.trim() || deriveLabel(draft.text),
    text: draft.text,
    submit: draft.submit || timed,
    newSession,
    project: newSession ? draft.project || null : null,
    schedule,
    at,
    session: timed ? draft.session || null : null,
    // Kept through an edit, so the session that made it can still cancel it.
    origin: draft.origin ?? null,
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

/**
 * Swap a prompt with its neighbour in the same group.
 *
 * The pane shows "this session", "new session" and scheduled prompts as three
 * lists, so the
 * neighbour is the next one the user can see, not the next one stored: swapping
 * across groups would be a move that changes nothing on screen. Off either end
 * is a no-op, not a wrap.
 */
export function movePrompt(
  prompts: readonly QuickPrompt[],
  id: string,
  delta: -1 | 1,
): QuickPrompt[] {
  const from = prompts.findIndex((prompt) => prompt.id === id);
  if (from < 0) return [...prompts];
  const group = groupOf(prompts[from]);
  let to = from + delta;
  while (to >= 0 && to < prompts.length && groupOf(prompts[to]) !== group) to += delta;
  if (to < 0 || to >= prompts.length) return [...prompts];
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

/**
 * A turn for one pane that bypasses its composer: a run nobody clicked (a
 * follow-up arriving in a session someone may be typing in), where appending
 * to the draft would send their half-message too.
 *
 * Kept as a list per pane, not one slot like `PasteRequest`: two follow-ups due
 * in the same tick land in one render, and a slot would keep only the second.
 */
export interface DirectRequest {
  token: number;
  text: string;
}

/** How many direct requests a pane's list keeps. Served ones are history. */
export const DIRECT_KEEP = 20;
