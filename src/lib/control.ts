/**
 * Client half of the CLI's stream-json control protocol.
 *
 * The CLI takes `control_request` frames on the same stdin it takes user turns
 * on, and answers each with a `control_response` carrying the same
 * `request_id`. That channel is how the interactive TUI fills its panels —
 * /model, /mcp, /context, /usage — and it is the only way to reach them from a
 * `--print` session, which refuses to run those commands because they are Ink
 * components rather than prompts.
 *
 * None of this needs Rust. `claude_send_raw` already writes an arbitrary frame,
 * and the stdout reader forwards every line to `claude://message` untouched, so
 * request/response correlation lives here and nowhere else.
 */

import { claudeSendRaw } from "./ipc";
import type {
  BinaryVersionResult,
  ClaudeFrame,
  ContextUsageResult,
  ControlSettingsResult,
  ControlUsageResult,
  InitializeResult,
  McpStatusResult,
  ModelOption,
  ReloadPluginsResult,
  ReloadSkillsResult,
} from "./types";

/** How long a request waits before it is cancelled and rejected. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * `initialize` is slower than the rest: on a cold start it walks skills,
 * plugins, agents and MCP configuration from disk before it can answer.
 */
const INITIALIZE_TIMEOUT_MS = 60_000;

interface Pending {
  chatId: string;
  subtype: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
let counter = 0;

/** Remove a request from the table and stop its timeout. Safe to call twice. */
function take(requestId: string): Pending | undefined {
  const entry = pending.get(requestId);
  if (!entry) return undefined;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  return entry;
}

/**
 * Send one control request and resolve with its success payload.
 *
 * Rejects on an error response, on a write failure, and on timeout — and a
 * timeout also withdraws the request, so a slow answer arriving later is not
 * mistaken for the answer to something else.
 */
export function claudeControl<T = unknown>(
  chatId: string,
  subtype: string,
  params: Record<string, unknown> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  // Prefixed so a response to something mangouste did not send — another client
  // sharing the session — is recognisably not ours.
  const requestId = `mangouste-${(counter += 1)}-${Date.now()}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      void claudeSendRaw(chatId, {
        type: "control_cancel_request",
        request_id: requestId,
      }).catch(() => {
        // The process is gone, which is the same outcome the reject reports.
      });
      reject(new Error(`${subtype} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pending.set(requestId, {
      chatId,
      subtype,
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    });

    void claudeSendRaw(chatId, {
      type: "control_request",
      request_id: requestId,
      request: { subtype, ...params },
    }).catch((e) => {
      const entry = take(requestId);
      entry?.reject(new Error(`${subtype} could not be sent: ${e}`));
    });
  });
}

/**
 * Hand a frame to the control channel. True when it was one, and so is not
 * conversation the transcript should render.
 *
 * `chatId` is checked against the request's own, so a frame that reached the
 * wrong pane cannot resolve a request the other pane is waiting on.
 */
export function resolveControlResponse(chatId: string, frame: ClaudeFrame): boolean {
  if (frame.type !== "control_response") return false;
  // The envelope nests a second `response`: the outer one is the reply itself,
  // the inner one is the payload shaped for the request's subtype.
  const envelope = frame.response as
    | { subtype?: string; request_id?: string; response?: unknown; error?: string }
    | undefined;
  const requestId = envelope?.request_id;
  if (!requestId) return true;
  const entry = pending.get(requestId);
  // Unknown id, or an id belonging to another pane: still a control frame, so
  // it is swallowed either way rather than rendered as an unknown block.
  if (!entry || entry.chatId !== chatId) return true;
  take(requestId);
  if (envelope?.subtype === "success") entry.resolve(envelope.response ?? {});
  else entry.reject(new Error(envelope?.error ?? `${entry.subtype} failed`));
  return true;
}

/**
 * Fail every request outstanding against a chat.
 *
 * Called when the process exits or is replaced: nothing is going to answer
 * those, and a panel spinning forever is worse than one saying why it stopped.
 */
export function abortControl(chatId: string, reason: string): void {
  for (const [requestId, entry] of [...pending]) {
    if (entry.chatId !== chatId) continue;
    take(requestId);
    entry.reject(new Error(reason));
  }
}

/* ---------- typed requests ---------- */

/**
 * Announce the client and read back the session's catalog.
 *
 * Optional and normally the first line on stdin; sending it to a process that
 * is already initialized — an attach — is answered with the current state
 * instead of re-running session setup, so it is safe on both paths.
 */
export const controlInitialize = (chatId: string) =>
  claudeControl<InitializeResult>(chatId, "initialize", {}, INITIALIZE_TIMEOUT_MS);

export const controlListModels = (chatId: string) =>
  claudeControl<{ models: ModelOption[] }>(chatId, "list_models");

/** `null` (or "default") resets to the session default rather than pinning one. */
export const controlSetModel = (chatId: string, model: string | null) =>
  claudeControl<{ model?: string }>(chatId, "set_model", { model });

export const controlMcpStatus = (chatId: string) =>
  claudeControl<McpStatusResult>(chatId, "mcp_status");

export const controlMcpReconnect = (chatId: string, serverName: string) =>
  claudeControl<unknown>(chatId, "mcp_reconnect", { serverName });

export const controlMcpToggle = (chatId: string, serverName: string, enabled: boolean) =>
  claudeControl<unknown>(chatId, "mcp_toggle", { serverName, enabled });

export const controlContextUsage = (chatId: string) =>
  claudeControl<ContextUsageResult>(chatId, "get_context_usage");

export const controlUsage = (chatId: string) =>
  claudeControl<ControlUsageResult>(chatId, "get_usage");

/** The same summary `/cost` prints, already stripped of ANSI. */
export const controlSessionCost = (chatId: string) =>
  claudeControl<{ text: string }>(chatId, "get_session_cost");

/**
 * Change the permission mode of the running process.
 *
 * The headless CLI echoes the mode it adopted, and it takes effect on the
 * running process — no respawn. Both the /permissions panel and the composer's
 * mode switch come through here whenever there is a process to talk to.
 */
export const controlSetPermissionMode = (chatId: string, mode: string) =>
  claudeControl<{ mode?: string }>(chatId, "set_permission_mode", { mode });

export const controlRenameSession = (chatId: string, title: string) =>
  claudeControl<unknown>(chatId, "rename_session", { title });

export const controlSettings = (chatId: string) =>
  claudeControl<ControlSettingsResult>(chatId, "get_settings");

export const controlBinaryVersion = (chatId: string) =>
  claudeControl<BinaryVersionResult>(chatId, "get_binary_version");

export const controlReloadSkills = (chatId: string) =>
  claudeControl<ReloadSkillsResult>(chatId, "reload_skills");

export const controlReloadPlugins = (chatId: string) =>
  claudeControl<ReloadPluginsResult>(chatId, "reload_plugins");
