/**
 * Threads: the long-lived pieces of work that sessions belong to.
 *
 * A session ends; the work often does not. A thread is the handle on "this
 * continues" that used to be a `[TBC]` typed into a session title: a status
 * only you change, the sessions under it, a note saying where it stands, and a
 * dated log. Stored by `src-tauri/src/threads.rs` as local markdown, owner-only,
 * never in a repo or anywhere shared.
 *
 * Everything here is pure: each edit returns a new thread, and the store in
 * `threadsContext.tsx` is the only thing that saves one.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SessionMeta } from "./types";

export type ThreadStatus = "open" | "blocked" | "done";

export interface ThreadSession {
  id: string;
  /** When it was attached, as a transcript timestamp. */
  added: string;
  cwd: string;
  /** The session's title when attached, so the thread reads without it. */
  title: string;
}

export interface LogLine {
  at: string;
  text: string;
}

/** Mirrors `Thread` in `src-tauri/src/threads.rs`. */
export interface Thread {
  /** File stem, fixed at creation. A rename changes `title`, not this. */
  id: string;
  title: string;
  status: ThreadStatus;
  created: string;
  updated: string;
  /** Where it stands / what is next. */
  note: string;
  sessions: ThreadSession[];
  log: LogLine[];
  /** Sections of the file this app does not own, carried through verbatim. */
  extra: string;
}

export const threadsList = () => invoke<Thread[]>("threads_list");
export const threadCreate = (title: string, session: ThreadSession | null) =>
  invoke<Thread>("thread_create", { title, session });
export const threadSave = (thread: Thread) => invoke<Thread>("thread_save", { thread });
export const threadPath = (id: string) => invoke<string>("thread_path", { id });
export const onThreadsChanged = (handler: () => void): Promise<UnlistenFn> =>
  listen("threads://changed", handler);

/** Longest title a thread starts with when it is made from a session. */
const TITLE_FROM_SESSION_CHARS = 80;

/** Notes past this are cut in the primer; the file still has all of it. */
const PRIMER_NOTE_CHARS = 4_000;

export function nowStamp(now: number = Date.now()): string {
  return new Date(now).toISOString();
}

/** A session as a thread member, captured at the moment it is attached. */
export function memberOf(session: SessionMeta, now: number = Date.now()): ThreadSession {
  return {
    id: session.id,
    added: nowStamp(now),
    cwd: session.cwd ?? "",
    title: session.title ?? session.id.slice(0, 8),
  };
}

/**
 * The title a thread made from a session starts with. A `[TBC]`-style tag is
 * dropped: it was standing in for exactly the thing the thread now is.
 */
export function titleFromSession(session: SessionMeta): string {
  const raw = session.title ?? session.lastPrompt ?? session.id.slice(0, 8);
  const stripped = raw.replace(/^\s*\[(tbc|todo|wip)\]\s*/i, "").trim();
  return (stripped || raw).slice(0, TITLE_FROM_SESSION_CHARS);
}

function logged(thread: Thread, text: string, now: number): LogLine[] {
  return [...thread.log, { at: nowStamp(now), text }];
}

export function withSession(thread: Thread, member: ThreadSession, now = Date.now()): Thread {
  if (thread.sessions.some((s) => s.id === member.id)) return thread;
  return {
    ...thread,
    sessions: [...thread.sessions, member],
    log: logged(thread, `added ${member.id.slice(0, 8)} · ${member.title}`, now),
  };
}

export function withoutSession(thread: Thread, sessionId: string, now = Date.now()): Thread {
  const gone = thread.sessions.find((s) => s.id === sessionId);
  if (!gone) return thread;
  return {
    ...thread,
    sessions: thread.sessions.filter((s) => s.id !== sessionId),
    log: logged(thread, `removed ${sessionId.slice(0, 8)} · ${gone.title}`, now),
  };
}

const STATUS_LOG: Record<ThreadStatus, string> = {
  open: "reopened",
  blocked: "marked blocked",
  done: "closed",
};

export function withStatus(thread: Thread, status: ThreadStatus, now = Date.now()): Thread {
  if (thread.status === status) return thread;
  return { ...thread, status, log: logged(thread, STATUS_LOG[status], now) };
}

/** Note edits are not logged: the note is the current state, not an event. */
export function withNote(thread: Thread, note: string): Thread {
  return note === thread.note ? thread : { ...thread, note };
}

export function withTitle(thread: Thread, title: string, now = Date.now()): Thread {
  const next = title.trim();
  if (!next || next === thread.title) return thread;
  return { ...thread, title: next, log: logged(thread, `renamed from ${thread.title}`, now) };
}

/** Open and blocked threads first, then by last update, newest first. */
export function sortThreads(threads: Thread[]): Thread[] {
  const rank = (t: Thread) => (t.status === "done" ? 1 : 0);
  return [...threads].sort(
    (a, b) => rank(a) - rank(b) || b.updated.localeCompare(a.updated),
  );
}

/** Threads a session belongs to, in the order given. */
export function threadsOf(threads: Thread[], sessionId: string): Thread[] {
  return threads.filter((t) => t.sessions.some((s) => s.id === sessionId));
}

/** Where a continuation runs: the newest member's repo, else the fallback. */
export function continueCwd(thread: Thread, fallback: string | null): string | null {
  const newest = [...thread.sessions].reverse().find((s) => s.cwd);
  return newest?.cwd || fallback;
}

/**
 * The first message of a session that continues a thread. Pre-filled in the
 * composer, never sent on its own: you read it, trim it, then send it.
 *
 * Transcript paths are included where the rail knows them, so the new session
 * can read the earlier work itself instead of being told about it.
 */
export function continuePrimer(thread: Thread, metaById: Map<string, SessionMeta>): string {
  const note = thread.note.trim();
  const lines = [
    `Continuing "${thread.title}".`,
    "",
    "Where it stands / next:",
    note ? note.slice(0, PRIMER_NOTE_CHARS) : "(no note yet)",
  ];
  if (thread.sessions.length > 0) {
    lines.push("", "Earlier sessions on this, oldest first:");
    for (const s of thread.sessions) {
      const file = metaById.get(s.id)?.file;
      const day = s.added.slice(0, 10);
      lines.push(`- ${day} ${s.title} (${s.id})${file ? ` transcript: ${file}` : ""}`);
    }
    lines.push("", "Read what you need from those before starting.");
  }
  return lines.join("\n");
}

/** Plain markdown for "copy": the note and the members, no local paths. */
export function threadAsMarkdown(thread: Thread): string {
  const lines = [`# ${thread.title}`, "", `status: ${thread.status}`, ""];
  if (thread.note.trim()) lines.push(thread.note.trim(), "");
  if (thread.sessions.length > 0) {
    lines.push("## Sessions", "");
    for (const s of thread.sessions) lines.push(`- ${s.added.slice(0, 10)} ${s.title}`);
  }
  return lines.join("\n").trimEnd() + "\n";
}
