/**
 * Session control: what a session asks of mangouste through its MCP tools.
 *
 * The backend forwards each call here as a `control://request` (see
 * `src-tauri/src/control.rs`), to the main window only, since it owns the
 * schedule clock. Everything in this module is pure: it reads a call's
 * arguments, checks them, and says what to do, so the rules can be tested
 * without a window. `App.tsx` does the doing.
 *
 * Arguments come from a model, so none of them is trusted: every field is read
 * as `unknown` and narrowed, and a call that does not make sense is refused
 * with a sentence the model can act on.
 */

import { formatRun, nextRun, parseCron } from "./cron";
import { isUnder } from "./fileOps";
import { deriveLabel, isTimed, type QuickPrompt } from "./quickPrompts";
import type { ProjectGroup } from "./types";

/** The tools `control.rs` lists. */
export type ControlTool =
  | "schedule_prompt"
  | "list_scheduled"
  | "cancel_scheduled"
  | "new_session"
  | "fork_session";

export interface ControlRequest {
  id: string;
  /** The calling chat, when it is one of ours. Null from `mangouste --mcp`. */
  chatId: string | null;
  /** The calling chat's session and repo, as the backend's chat manager has them. */
  sessionId: string | null;
  cwd: string | null;
  tool: ControlTool;
  arguments: unknown;
}

export function callerOf(request: ControlRequest): ControlCaller {
  return { inChat: request.chatId !== null, sessionId: request.sessionId, cwd: request.cwd };
}

/** Who called, as far as this window can tell from the chat id. */
export interface ControlCaller {
  /** The call came from one of this app's chats, so it is held to its own session. */
  inChat: boolean;
  sessionId: string | null;
  cwd: string | null;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const fail = <T>(error: string): Outcome<T> => ({ ok: false, error });

/**
 * Most timed prompts the list may hold. A ceiling, not a quota: it is what
 * stops a session that schedules itself in a loop from filling the store
 * before anyone notices.
 */
export const MAX_TIMED = 50;

/** The `origin` of a prompt scheduled through `mangouste --mcp`, which has no session. */
export const OUTSIDE_ORIGIN = "outside";

/** Furthest ahead a one-off may be set. Past this it is a typo, not a plan. */
const MAX_LEAD_MS = 366 * 24 * 60 * 60 * 1000;

/** How far in the past an `at` may be and still count as "now". */
const PAST_GRACE_MS = 60_000;

/** Longest prompt a call may hand over. */
const MAX_TEXT = 20_000;

function record(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function optionalString(args: Record<string, unknown>, key: string): Outcome<string | null> {
  const value = args[key];
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== "string") return fail(`\`${key}\` must be a string`);
  const trimmed = value.trim();
  return ok(trimmed === "" ? null : trimmed);
}

function readText(args: Record<string, unknown>, required: boolean): Outcome<string | null> {
  const value = args.text;
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    return required ? fail("`text` is required") : ok(null);
  }
  if (typeof value !== "string") return fail("`text` must be a string");
  if (value.length > MAX_TEXT) return fail(`\`text\` is over ${MAX_TEXT} characters`);
  return ok(value);
}

/**
 * The session a call may act on: its own, when it comes from one of our chats.
 *
 * A session reaching into another one is how a prompt injection read in one
 * repo turns into turns sent in another, possibly one running in bypass mode.
 * So a chat may name only itself. A caller with no chat (`mangouste --mcp`, a
 * `claude` the user started by hand and wired up on purpose) may name any.
 */
function ownSession(requested: string | null, caller: ControlCaller): Outcome<string | null> {
  if (caller.inChat && requested && requested !== caller.sessionId) {
    return fail("a session may only act on itself; leave `session_id` out");
  }
  return ok(requested ?? caller.sessionId);
}

/**
 * Who a session-made prompt belongs to: the session that scheduled it. It is
 * what `list_scheduled` and `cancel_scheduled` filter on, so a session sees and
 * removes only its own, and the prompts made by hand in the Prompts view (no
 * origin) are nobody's to read or delete through these tools.
 */
function originOf(caller: ControlCaller): Outcome<string> {
  if (!caller.inChat) return ok(OUTSIDE_ORIGIN);
  if (!caller.sessionId) return fail("this session has not started yet; try again after its first reply");
  return ok(caller.sessionId);
}

/** Whether `caller` may see and cancel `prompt`. */
function visibleTo(prompt: QuickPrompt, caller: ControlCaller): boolean {
  if (prompt.origin === null || !isTimed(prompt)) return false;
  return caller.inChat ? prompt.origin === caller.sessionId : true;
}

/**
 * The repo a call may start work in.
 *
 * A chat is held to its own repo, for the same reason it is held to its own
 * session: a new session somewhere else runs with the app's default permission
 * mode, which may be bypass, and a cron entry there keeps running long after the
 * chat that planted it is gone.
 */
function readProject(args: Record<string, unknown>, caller: ControlCaller): Outcome<string | null> {
  const project = optionalString(args, "project");
  if (!project.ok) return project;
  if (project.value === null) return ok(caller.cwd);
  const path = project.value.replace(/\/+$/, "") || "/";
  if (!path.startsWith("/") || path.split("/").some((part) => part === "." || part === "..")) {
    return fail("`project` must be an absolute path with no `.` or `..` in it");
  }
  if (caller.inChat && !(caller.cwd && isUnder(path, caller.cwd))) {
    return fail("a session may only start work in its own repo; leave `project` out");
  }
  return ok(path);
}

/** When a one-off runs, from `at` or `in_minutes`. Null for a cron prompt. */
function readWhen(args: Record<string, unknown>, now: Date): Outcome<{ at: string | null; cron: string | null }> {
  const given = ["at", "in_minutes", "cron"].filter(
    (key) => args[key] !== undefined && args[key] !== null && args[key] !== "",
  );
  if (given.length !== 1) return fail("give exactly one of `at`, `in_minutes` or `cron`");

  if (given[0] === "cron") {
    const cron = optionalString(args, "cron");
    if (!cron.ok) return cron;
    const parsed = parseCron(cron.value ?? "");
    if (!parsed.ok) return fail(`\`cron\` does not parse: ${parsed.error}`);
    if (!nextRun(parsed.cron, now)) return fail("`cron` never fires");
    return ok({ at: null, cron: cron.value });
  }

  let when: number;
  if (given[0] === "in_minutes") {
    const minutes = args.in_minutes;
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
      return fail("`in_minutes` must be a positive number");
    }
    when = now.getTime() + Math.round(minutes * 60_000);
  } else {
    const at = optionalString(args, "at");
    if (!at.ok) return at;
    when = Date.parse(at.value ?? "");
    if (Number.isNaN(when)) return fail("`at` is not an ISO 8601 timestamp");
    if (when < now.getTime() - PAST_GRACE_MS) return fail("`at` is in the past");
  }
  if (when > now.getTime() + MAX_LEAD_MS) return fail("that is more than a year away");
  return ok({ at: new Date(when).toISOString(), cron: null });
}

/** Read a `schedule_prompt` call into the prompt it should add. */
export function planSchedule(
  args: unknown,
  caller: ControlCaller,
  existing: readonly QuickPrompt[],
  now: Date,
  id: string,
): Outcome<QuickPrompt> {
  const input = record(args);
  const origin = originOf(caller);
  if (!origin.ok) return fail(origin.error);
  if (existing.filter(isTimed).length >= MAX_TIMED) {
    return fail(`mangouste already holds ${MAX_TIMED} timed prompts; cancel some first`);
  }
  const text = readText(input, true);
  if (!text.ok) return fail(text.error);
  const label = optionalString(input, "label");
  if (!label.ok) return fail(label.error);
  const when = readWhen(input, now);
  if (!when.ok) return fail(when.error);
  const project = readProject(input, caller);
  if (!project.ok) return fail(project.error);
  const sessionArg = optionalString(input, "session_id");
  if (!sessionArg.ok) return fail(sessionArg.error);

  const target = input.target ?? (sessionArg.value ?? caller.sessionId ? "this_session" : "new_session");
  if (target !== "this_session" && target !== "new_session") {
    return fail("`target` must be \"this_session\" or \"new_session\"");
  }
  let session: string | null = null;
  if (target === "this_session") {
    const own = ownSession(sessionArg.value, caller);
    if (!own.ok) return fail(own.error);
    session = own.value;
    if (!session) {
      return fail("no session to follow up in: pass `session_id`, or use target \"new_session\"");
    }
  } else if (!project.value) {
    return fail("no repo to start the session in: pass `project`");
  }

  return ok({
    id,
    label: label.value ?? deriveLabel(text.value!),
    text: text.value!,
    submit: true,
    newSession: true,
    project: project.value,
    schedule: when.value.cron,
    at: when.value.at,
    session,
    origin: origin.value,
  });
}

export interface ScheduledEntry {
  id: string;
  label: string;
  text: string;
  /** The cron expression, or `once` for a one-off. */
  schedule: string;
  /** Next run as an ISO timestamp, or null when a cron never fires. */
  nextRun: string | null;
  /** Session uuid it follows up in, or null for a new session. */
  session: string | null;
  project: string | null;
}

/** What `list_scheduled` hands back: the caller's own timed prompts. */
export function describeScheduled(
  prompts: readonly QuickPrompt[],
  now: Date,
  caller: ControlCaller,
): ScheduledEntry[] {
  return prompts.filter((prompt) => visibleTo(prompt, caller)).map((prompt) => {
    let next: string | null = prompt.at;
    if (prompt.schedule) {
      const parsed = parseCron(prompt.schedule);
      const run = parsed.ok ? nextRun(parsed.cron, now) : null;
      next = run ? run.toISOString() : null;
    }
    return {
      id: prompt.id,
      label: prompt.label,
      text: prompt.text,
      schedule: prompt.schedule ?? "once",
      nextRun: next,
      session: prompt.session,
      project: prompt.project,
    };
  });
}

/** Read a `cancel_scheduled` call into the id of one of the caller's timed prompts. */
export function planCancel(
  args: unknown,
  prompts: readonly QuickPrompt[],
  caller: ControlCaller,
): Outcome<string> {
  const id = optionalString(record(args), "id");
  if (!id.ok) return fail(id.error);
  if (!id.value) return fail("`id` is required");
  const match = prompts.find((prompt) => prompt.id === id.value);
  if (!match || !visibleTo(match, caller)) return fail(`no scheduled prompt of yours with id ${id.value}`);
  return ok(match.id);
}

export interface SpawnPlan {
  text: string;
  project: string;
  focus: boolean;
}

/** Read a `new_session` call. */
export function planNewSession(args: unknown, caller: ControlCaller): Outcome<SpawnPlan> {
  const input = record(args);
  const text = readText(input, true);
  if (!text.ok) return fail(text.error);
  const project = readProject(input, caller);
  if (!project.ok) return fail(project.error);
  if (!project.value) return fail("no repo to start the session in: pass `project`");
  return ok({ text: text.value!, project: project.value, focus: input.focus === true });
}

export interface ForkPlan {
  session: string;
  text: string | null;
  focus: boolean;
}

/** Read a `fork_session` call. */
export function planFork(args: unknown, caller: ControlCaller): Outcome<ForkPlan> {
  const input = record(args);
  const text = readText(input, false);
  if (!text.ok) return fail(text.error);
  const session = optionalString(input, "session_id");
  if (!session.ok) return fail(session.error);
  const own = ownSession(session.value, caller);
  if (!own.ok) return fail(own.error);
  if (!own.value) return fail("no session to fork: pass `session_id`");
  return ok({ session: own.value, text: text.value, focus: input.focus === true });
}

/** Where a session lives on disk, from the rail's scan. */
export function findSession(
  groups: readonly ProjectGroup[],
  sessionId: string,
): { cwd: string; file: string | null } | null {
  for (const group of groups) {
    const match = group.sessions.find((session) => session.id === sessionId);
    if (match) return { cwd: group.cwd, file: match.file ?? null };
  }
  return null;
}

/** A one-line summary of when a timed prompt runs, for the Prompts view. */
export function whenCaption(prompt: Pick<QuickPrompt, "schedule" | "at">, now: Date): string | null {
  if (prompt.schedule) {
    const parsed = parseCron(prompt.schedule);
    if (!parsed.ok) return parsed.error;
    const next = nextRun(parsed.cron, now);
    return next ? `next ${formatRun(next, now)}` : "never fires";
  }
  if (prompt.at) {
    const at = new Date(prompt.at);
    return at.getTime() <= now.getTime() ? "due now" : `once ${formatRun(at, now)}`;
  }
  return null;
}
