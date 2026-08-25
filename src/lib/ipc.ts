/** Typed wrappers over the Rust commands. One place to change if a signature moves. */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  BranchList,
  ChatStatus,
  ClaudeUsage,
  ClipboardImage,
  PermissionRequest,
  ClaudeFrame,
  Commit,
  DirEntryInfo,
  FileText,
  Formatted,
  ProjectGroup,
  ReplaceOutcome,
  RepoInfo,
  RepoStatus,
  SearchOptions,
  SearchOutcome,
  StartOptions,
  SessionHit,
  StatsSummary,
  TerminalInfo,
} from "./types";

/* ---------- external links ---------- */

/** Schemes the OS handler is allowed to see. Anything else stays in the app. */
const OPENABLE = /^(?:https?|mailto|tel):/i;

/**
 * Hand a link to the desktop's default application.
 *
 * The webview has nowhere to navigate to — `window.open` is inert inside it and
 * a plain anchor would replace the app itself — so every link has to leave
 * through the opener plugin. Resolves to `false` when the scheme is not one we
 * hand out or the platform refused, so callers can fall back to copying.
 */
export async function openExternal(url: string): Promise<boolean> {
  if (!OPENABLE.test(url)) return false;
  try {
    await openUrl(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Show a path in the desktop's file manager.
 *
 * Resolves to `false` when the platform has no handler or the path is gone, so
 * a menu item can stay quiet rather than raising a dialog nobody asked for.
 */
export async function revealPath(path: string): Promise<boolean> {
  try {
    await revealItemInDir(path);
    return true;
  } catch {
    return false;
  }
}

/* ---------- selection + clipboard ---------- */

export const primaryGet = () => invoke<string>("primary_get");
/** Resolves to `true` when PRIMARY ownership was actually taken. */
export const primarySet = (text: string) => invoke<boolean>("primary_set", { text });
export const clipboardGet = () => invoke<string>("clipboard_get");
export const clipboardSet = (text: string) => invoke<void>("clipboard_set", { text });
/** Returns null when the clipboard holds text rather than an image. */
export const clipboardImage = () => invoke<ClipboardImage | null>("clipboard_image");

/* ---------- sessions ---------- */

export const listSessions = () => invoke<ProjectGroup[]>("list_sessions");
export const readSessionTranscript = (file: string, limit?: number) =>
  invoke<ClaudeFrame[]>("read_session_transcript", { file, limit });

/**
 * Search inside every transcript, not just the metadata a scan holds.
 *
 * Sweeps ~300 MB across the corpus, so it belongs on an explicit user action
 * rather than on a keystroke. `anyTerm` ORs the terms instead of ANDing them,
 * which is what the Haiku-expanded term list needs.
 */
export const searchSessions = (query: string, anyTerm = false, limit?: number) =>
  invoke<SessionHit[]>("search_sessions", { query, anyTerm, limit });

/**
 * Ask Haiku for words that would plausibly appear in the session being looked
 * for. The literal search then runs again over them — the model proposes terms
 * and never decides what matches.
 */
export const expandSearchTerms = (query: string) =>
  invoke<string[]>("expand_search_terms", { query });

export const onSessionsChanged = (handler: () => void): Promise<UnlistenFn> =>
  listen("sessions://changed", handler);

/** Appends a `custom-title` record, which outranks any AI title. */
export const renameSession = (sessionId: string, title: string) =>
  invoke<void>("rename_session", { sessionId, title });

/* ---------- chat ---------- */

/**
 * Attach to the live chat under `options.chatId`, or spawn one if there is none.
 *
 * Attaching is what a pane remount hits: the child is still there, possibly
 * mid-turn, and reconnecting to it by chat id is what keeps a second writer off
 * the same transcript.
 */
export const claudeStart = (options: StartOptions) =>
  invoke<ChatStatus>("claude_start", { options });
/** Kill and respawn. For the restart control and for applying a new mode. */
export const claudeRestart = (options: StartOptions) =>
  invoke<ChatStatus>("claude_restart", { options });
export const claudeSend = (chatId: string, text: string) =>
  invoke<void>("claude_send", { chatId, text });
export const claudeSendRaw = (chatId: string, frame: unknown) =>
  invoke<void>("claude_send_raw", { chatId, frame });
export const claudeInterrupt = (chatId: string, requestId: string) =>
  invoke<void>("claude_interrupt", { chatId, requestId });
/**
 * Stop watching a chat, leaving the process running.
 *
 * What an unmounting pane calls. A no-op in Rust — children live and die with
 * the window, so there is no detached state to bookkeep — and it stays a no-op
 * so remounting a pane cannot kill a turn that is still streaming. Ending a
 * session for real is `claudeKill`.
 */
export const claudeDetach = (chatId: string) => invoke<void>("claude_detach", { chatId });
/**
 * End a session for real. Only from an explicit user action.
 *
 * `instance` makes the kill a no-op if this spawn has already been replaced.
 */
export const claudeKill = (chatId: string, instance?: number) =>
  invoke<void>("claude_kill", { chatId, instance });
/** Every chat this window owns, whether or not a pane is watching it. */
export const claudeStatus = () => invoke<ChatStatus[]>("claude_status");

export const onClaudeMessage = (
  handler: (event: { chatId: string; instance: number; payload: ClaudeFrame }) => void,
): Promise<UnlistenFn> =>
  listen<{ chatId: string; instance: number; payload: ClaudeFrame }>(
    "claude://message",
    (e) => handler(e.payload),
  );

export const onClaudeStderr = (
  handler: (event: { chatId: string; instance: number; line: string }) => void,
): Promise<UnlistenFn> =>
  listen<{ chatId: string; instance: number; line: string }>("claude://stderr", (e) =>
    handler(e.payload),
  );

/** One line of the CLI's `--debug-file`, tailed by Rust. Only flows when the
    chat was spawned with `debug: true`. */
export const onClaudeDebug = (
  handler: (event: { chatId: string; instance: number; line: string }) => void,
): Promise<UnlistenFn> =>
  listen<{ chatId: string; instance: number; line: string }>("claude://debug", (e) =>
    handler(e.payload),
  );

/**
 * What is actually executing under the CLI right now, from the Rust /proc
 * probe. `command: null` means the tool subprocess has finished.
 */
export const onClaudeToolActivity = (
  handler: (event: { chatId: string; instance: number; command: string | null }) => void,
): Promise<UnlistenFn> =>
  listen<{ chatId: string; instance: number; command: string | null }>(
    "claude://tool-activity",
    (e) => handler(e.payload),
  );

export const onClaudeExit = (
  handler: (event: { chatId: string; instance: number; code: number | null }) => void,
): Promise<UnlistenFn> =>
  listen<{ chatId: string; instance: number; code: number | null }>("claude://exit", (e) =>
    handler(e.payload),
  );

/* ---------- terminal ---------- */

export const ptyOpen = (id: string, cwd: string, cols: number, rows: number) =>
  invoke<TerminalInfo>("pty_open", { id, cwd, cols, rows });
export const ptyWrite = (id: string, data: string) => invoke<void>("pty_write", { id, data });
export const ptyResize = (id: string, cols: number, rows: number) =>
  invoke<void>("pty_resize", { id, cols, rows });
/** `instance` makes the close a no-op if this terminal has already been replaced. */
export const ptyClose = (id: string, instance?: number) =>
  invoke<void>("pty_close", { id, instance });
export const ptyList = () => invoke<TerminalInfo[]>("pty_list");

export const onPtyData = (
  handler: (event: { id: string; instance: number; data: string }) => void,
): Promise<UnlistenFn> =>
  listen<{ id: string; instance: number; data: string }>("pty://data", (e) =>
    handler(e.payload),
  );

export const onPtyExit = (
  handler: (event: { id: string; instance: number }) => void,
): Promise<UnlistenFn> =>
  listen<{ id: string; instance: number }>("pty://exit", (e) => handler(e.payload));

/* ---------- files ---------- */

export const listDir = (
  path: string,
  respectGitignore = true,
  showHidden = true,
) => invoke<DirEntryInfo[]>("list_dir", { path, respectGitignore, showHidden });

export const discoverRepos = (root: string) => invoke<RepoInfo[]>("discover_repos", { root });
export const searchFiles = (root: string, query: string, limit?: number) =>
  invoke<DirEntryInfo[]>("search_files", { root, query, limit });
export const readTextFile = (path: string, maxBytes?: number) =>
  invoke<string>("read_text_file", { path, maxBytes });

/**
 * Read a file together with its mtime — what the editor opens through.
 *
 * The mtime has to come from the same stat as the bytes, or a rewrite landing
 * between two calls would go unnoticed and `writeTextFile` would happily
 * overwrite it.
 */
export const readTextFileMeta = (path: string, maxBytes?: number) =>
  invoke<FileText>("read_text_file_meta", { path, maxBytes });

/**
 * Save text over an existing file, resolving to the new mtime.
 *
 * `expectedModifiedMs` is optimistic locking: the save is refused if the file
 * changed since it was read, which is the common case once claude is editing
 * the same tree. Pass `undefined` to overwrite regardless.
 */
export const writeTextFile = (path: string, content: string, expectedModifiedMs?: number) =>
  invoke<number>("write_text_file", { path, content, expectedModifiedMs });

/**
 * Reformat a buffer with whatever formatter the repo the file lives in uses.
 *
 * Text in, text out: the draft never touches disk on the way, so an unsaved
 * buffer can be formatted and the mtime `writeTextFile` checks stays the one the
 * file was read at. Rejects when nothing is installed for the file's type, which
 * is a note for the status line rather than a failure.
 */
export const formatText = (path: string, text: string) =>
  invoke<Formatted>("format_text", { path, text });
export const homeDir = () => invoke<string | null>("home_dir");

/* ---------- find and replace ---------- */

/**
 * Sweep every file under `root` for `query`, matching line by line.
 *
 * Walks the same tree the Explorer shows and reads through the same guards the
 * editor opens through, so what a find can reach is what you could have opened
 * by hand. Bounded in Rust — a per-file cap, a global match cap, a file-size
 * ceiling — because the pane is blocked on the answer; `truncated` says when the
 * results are a prefix rather than the whole truth.
 */
export const searchText = (root: string, query: string, options: SearchOptions) =>
  invoke<SearchOutcome>("search_text", { root, query, options });

/**
 * Rewrite the given files, replacing the matches they still carry spans for.
 *
 * `query` and `options` ride along so Rust can re-run the same matcher and prove
 * each span is still a match before touching it, and each target's `modifiedMs`
 * is the same optimistic lock `writeTextFile` uses — a file claude rewrote since
 * the search is refused rather than clobbered. One refusal does not stop the
 * others: the outcome reports per file.
 */
export const replaceMatches = (
  query: string,
  options: SearchOptions,
  replacement: string,
  targets: { path: string; modifiedMs?: number; spans?: [number, number][] }[],
) => invoke<ReplaceOutcome>("replace_matches", { query, options, replacement, targets });

/* ---------- git ---------- */

export const gitLog = (cwd: string, limit?: number, skip?: number, allBranches = true) =>
  invoke<Commit[]>("git_log", { cwd, limit, skip, allBranches });
export const gitStatus = (cwd: string) => invoke<RepoStatus>("git_status", { cwd });
export const gitShow = (cwd: string, sha: string) => invoke<string>("git_show", { cwd, sha });
export const gitDiffFile = (cwd: string, path: string, staged = false) =>
  invoke<string>("git_diff_file", { cwd, path, staged });
export const gitBranches = (cwd: string) => invoke<string[]>("git_branches", { cwd });
export const gitRoot = (cwd: string) => invoke<string | null>("git_root", { cwd });
export const gitStage = (cwd: string, paths: string[]) =>
  invoke<void>("git_stage", { cwd, paths });
export const gitUnstage = (cwd: string, paths: string[]) =>
  invoke<void>("git_unstage", { cwd, paths });
export const gitCommit = (cwd: string, message: string, amend = false) =>
  invoke<string>("git_commit", { cwd, message, amend });

/**
 * Irreversible: drops worktree edits to `tracked` and deletes `untracked`.
 * Only ever called behind a confirmation in the pane.
 */
export const gitDiscard = (cwd: string, tracked: string[], untracked: string[]) =>
  invoke<void>("git_discard", { cwd, tracked, untracked });

/* Network commands. Each resolves to git's own combined output, which the pane
   shows verbatim — a push rejection reads better in git's words than in ours. */
export const gitFetch = (cwd: string, remote?: string) =>
  invoke<string>("git_fetch", { cwd, remote });
/** Fast-forward only unless `rebase` is set, so no implicit merge commit. */
export const gitPull = (cwd: string, rebase = false) =>
  invoke<string>("git_pull", { cwd, rebase });
export const gitPush = (cwd: string, setUpstream = false) =>
  invoke<string>("git_push", { cwd, setUpstream });

export const gitBranchList = (cwd: string) => invoke<BranchList>("git_branch_list", { cwd });
export const gitCheckout = (cwd: string, branch: string) =>
  invoke<string>("git_checkout", { cwd, branch });
export const gitCreateBranch = (cwd: string, name: string) =>
  invoke<string>("git_create_branch", { cwd, name });
export const gitMerge = (cwd: string, branch: string) =>
  invoke<string>("git_merge", { cwd, branch });

/* ---------- dashboard statistics ---------- */

/**
 * Corpus-wide tokens, cost, tools and MCP calls across every transcript.
 *
 * The first call reads every transcript on the machine; later calls resume from
 * a byte offset per file, so refreshing on a watcher event is cheap.
 */
export const statsSummary = () => invoke<StatsSummary>("stats_summary");

/* ---------- usage ---------- */

/** Reads the local OAuth token and calls Anthropic's usage endpoint. Opt-in. */
export const fetchUsage = () => invoke<ClaudeUsage>("fetch_usage");

/* ---------- tool permissions ---------- */

export const permissionRespond = (
  id: string,
  behavior: "allow" | "deny",
  options?: { message?: string; updatedInput?: unknown },
) =>
  invoke<void>("permission_respond", {
    decision: {
      id,
      behavior,
      message: options?.message ?? null,
      updatedInput: options?.updatedInput ?? null,
    },
  });

export const onPermissionRequest = (
  handler: (request: PermissionRequest) => void,
): Promise<UnlistenFn> =>
  listen<PermissionRequest>("permission://request", (e) => handler(e.payload));
