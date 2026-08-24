/**
 * Slash commands in a `--print` session: which ones the CLI runs, which ones
 * mangouste has to run itself, and how the composer offers them.
 *
 * The CLI sorts its own commands into three groups, and only the third needs
 * anything from us:
 *
 *  1. Prompt commands — `.claude/commands/*.md`, plugin commands, skills, MCP
 *     prompts. Sent as ordinary user text; the CLI expands them into a turn.
 *  2. Local commands — `/context`, `/config`, `/agents` and friends. Also sent
 *     as text, answered with a synthetic assistant message and no API call.
 *  3. Interactive panels — `/permissions`, `/status`, `/help`, `/remote-control`.
 *     These are Ink components, so a headless CLI answers "isn't available in
 *     this environment". They are rebuilt here on the control protocol.
 *
 * `initialize.commands` already lists exactly groups 1 and 2, so the catalog
 * needs no filtering: whatever is in it can be typed straight through. NATIVE
 * covers group 3 plus the handful from group 2 worth rendering properly rather
 * than as a wall of synthetic text.
 */

import type { SlashCommand } from "./types";

/** A command mangouste answers itself, without the CLI seeing it. */
export type NativeCommand =
  | "model"
  | "mcp"
  | "context"
  | "usage"
  | "cost"
  | "permissions"
  | "status"
  | "help"
  | "version"
  | "config"
  | "rename"
  | "skills"
  | "plugin"
  | "remote-control";

interface NativeSpec {
  description: string;
  argumentHint?: string;
}

/**
 * Every command handled in-app, with the help text the menu shows.
 *
 * Overlapping with the CLI's own catalog is deliberate: `/model` and `/mcp` do
 * work headless, but they answer with one line of prose where the control
 * protocol hands back the structured data the TUI panel is built from.
 */
export const NATIVE: Record<NativeCommand, NativeSpec> = {
  model: { description: "Show or switch the model for this session", argumentHint: "[alias]" },
  mcp: { description: "MCP server connections, with reconnect and disable" },
  context: { description: "Context window usage, broken down by category" },
  usage: { description: "Plan rate-limit windows and session cost" },
  cost: { description: "Cost and duration of this session" },
  permissions: {
    description: "Show or change the permission mode, effective immediately",
    argumentHint: "[default|acceptEdits|plan|bypassPermissions]",
  },
  status: { description: "Session, account, model and binary version" },
  help: { description: "Every command available in this session" },
  version: { description: "CLI binary version and build time" },
  config: { description: "Effective settings, merged across every source" },
  rename: { description: "Set this session's title", argumentHint: "<title>" },
  skills: { description: "Reload skills from disk and list them" },
  plugin: { description: "Reload plugins from disk and list their commands" },
  "remote-control": { description: "Why /remote-control needs the terminal pane" },
};

/** Spellings that mean a native command under another name. */
const ALIASES: Record<string, NativeCommand> = {
  models: "model",
  perms: "permissions",
  permission: "permissions",
  plugins: "plugin",
  skill: "skills",
  ctx: "context",
  rc: "remote-control",
};

export interface ParsedSlash {
  /** Command name without the leading slash. */
  name: string;
  /** Everything after the first run of whitespace, untrimmed at the tail. */
  args: string;
}

/** Split typed text into a command and its arguments, or null if it is prose. */
export function parseSlash(text: string): ParsedSlash | null {
  const match = /^\/([^\s]+)\s*([\s\S]*)$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1], args: match[2] };
}

/** The native command this name resolves to, or null to let the CLI have it. */
export function toNative(name: string): NativeCommand | null {
  const lower = name.toLowerCase();
  if (lower in NATIVE) return lower as NativeCommand;
  return ALIASES[lower] ?? null;
}

/* ---------- composer autocomplete ---------- */

export interface MenuEntry {
  name: string;
  description: string;
  argumentHint?: string;
  /** Handled in-app rather than sent to the CLI. */
  native: boolean;
}

/**
 * Merge the CLI's catalog with the native commands, natives winning on a clash.
 *
 * Names starting with `__` are the CLI's internal plumbing (`__remote-workflow`)
 * and are never offered.
 */
export function buildMenu(catalog: SlashCommand[]): MenuEntry[] {
  const entries: MenuEntry[] = (Object.keys(NATIVE) as NativeCommand[]).map((name) => ({
    name,
    description: NATIVE[name].description,
    argumentHint: NATIVE[name].argumentHint,
    native: true,
  }));
  const taken = new Set(entries.map((entry) => entry.name));
  for (const command of catalog) {
    if (command.name.startsWith("__")) continue;
    if (taken.has(command.name) || toNative(command.name)) continue;
    taken.add(command.name);
    entries.push({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint || undefined,
      native: false,
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Rank the menu against what has been typed so far.
 *
 * Prefix matches first — typing "mo" should offer `/model` before
 * `/auto-mode-setup` — then substring, then subsequence, so a plugin command
 * remembered only by its middle word is still reachable.
 */
export function filterMenu(entries: MenuEntry[], query: string, limit = 40): MenuEntry[] {
  const needle = query.toLowerCase();
  if (!needle) return entries.slice(0, limit);
  const scored: { entry: MenuEntry; rank: number }[] = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    // A plugin command is `plugin:command`; matching the bare command half is
    // what people actually type.
    const tail = name.slice(name.indexOf(":") + 1);
    let rank: number;
    if (name.startsWith(needle)) rank = 0;
    else if (tail.startsWith(needle)) rank = 1;
    else if (name.includes(needle)) rank = 2;
    else if (isSubsequence(needle, name)) rank = 3;
    else continue;
    scored.push({ entry, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.entry.name.localeCompare(b.entry.name));
  return scored.slice(0, limit).map((item) => item.entry);
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return index === needle.length;
}

/**
 * What the composer's popup should be offering, given the draft and the caret.
 *
 * A slash command is the whole message, so its menu only opens while the draft
 * is one unbroken `/token` — the first space means you have moved on to
 * arguments. An `@` mention can appear anywhere, so its menu keys off the token
 * immediately before the caret.
 */
export type ComposerTrigger =
  | { kind: "command"; query: string; start: number }
  | { kind: "file"; query: string; start: number }
  | null;

export function detectTrigger(draft: string, caret: number): ComposerTrigger {
  if (caret > 0 && /^\/[^\s/]*$/.test(draft)) {
    return { kind: "command", query: draft.slice(1), start: 0 };
  }
  const before = draft.slice(0, caret);
  const at = /(?:^|\s)@(\S*)$/.exec(before);
  if (at) return { kind: "file", query: at[1], start: caret - at[1].length - 1 };
  return null;
}

/**
 * Replace the token a trigger covers with `replacement`, returning the new
 * draft and where the caret belongs in it.
 */
export function applyCompletion(
  draft: string,
  trigger: NonNullable<ComposerTrigger>,
  caret: number,
  replacement: string,
): { draft: string; caret: number } {
  const head = draft.slice(0, trigger.start);
  const tail = draft.slice(caret);
  const next = `${head}${replacement}${tail}`;
  return { draft: next, caret: head.length + replacement.length };
}

/* ---------- transcript echoes ---------- */

const TAG = {
  name: /<command-name>([\s\S]*?)<\/command-name>/,
  args: /<command-args>([\s\S]*?)<\/command-args>/,
  message: /<command-message>[\s\S]*?<\/command-message>/g,
  stdout: /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g,
  stderr: /<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/g,
};

export interface CommandEcho {
  name: string | null;
  args: string | null;
  stdout: string[];
  stderr: string[];
  /** Anything outside the tags, which is usually nothing. */
  rest: string;
}

/**
 * Pull a slash-command echo out of a stored transcript record.
 *
 * The CLI writes a ran command as `<command-name>` plus its output in
 * `<local-command-stdout>`, so a resumed session otherwise renders raw XML in
 * the middle of the conversation. Null when the text holds none of those tags.
 */
export function parseCommandEcho(text: string): CommandEcho | null {
  if (!text.includes("<command-name>") && !text.includes("<local-command-std")) return null;
  const name = TAG.name.exec(text)?.[1]?.trim() ?? null;
  const args = TAG.args.exec(text)?.[1]?.trim() || null;
  const stdout = [...text.matchAll(TAG.stdout)].map((m) => m[1].trim()).filter(Boolean);
  const stderr = [...text.matchAll(TAG.stderr)].map((m) => m[1].trim()).filter(Boolean);
  const rest = text
    .replace(TAG.name, "")
    .replace(TAG.args, "")
    .replace(TAG.message, "")
    .replace(TAG.stdout, "")
    .replace(TAG.stderr, "")
    .trim();
  return { name, args, stdout, stderr, rest };
}
