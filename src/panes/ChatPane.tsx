import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  claudeInterrupt,
  claudeSend,
  claudeSendRaw,
  clipboardImage,
  onPermissionRequest,
  permissionRespond,
  claudeStart,
  claudeDetach,
  claudeKill,
  claudeRestart,
  onClaudeDebug,
  onClaudeExit,
  onClaudeMessage,
  onClaudeStderr,
  onClaudeToolActivity,
  readSessionTranscript,
  searchFiles,
} from "../lib/ipc";
import {
  abortControl,
  controlInitialize,
  controlSetModel,
  controlSetPermissionMode,
  resolveControlResponse,
} from "../lib/control";
import {
  applyCompletion,
  buildMenu,
  detectTrigger,
  filterMenu,
  parseCommandEcho,
  parseSlash,
  toNative,
  type ComposerTrigger,
  type NativeCommand,
} from "../lib/slashCommands";
import { Activity } from "./Activity";
import { ComposerMenu, type ComposerMenuItem } from "./ComposerMenu";
import { ControlPanel } from "./ControlPanels";
import { Markdown } from "./Markdown";
import { ToolDiff, toolDiffLines } from "./Viewer";
import { cliDebugEnabled, logDebug } from "../lib/debugLog";
import { copyText } from "../lib/editing";
import { CHORD } from "../lib/keybindings";
import { useMenu, type MenuEntry } from "../lib/menu";
import type {
  ClaudeFrame,
  InitializeResult,
  PermissionRequest,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "../lib/types";

interface ChatPaneProps {
  chatId: string;
  cwd: string;
  /**
   * Whether this pane is the one on screen.
   *
   * Hidden panes keep streaming, but a `display: none` box measures zero, so
   * scrolling it to the bottom is a no-op that leaves it pinned to the top of
   * the transcript once it is shown again.
   */
  visible: boolean;
  /**
   * Restored but never shown: hold off the spawn and the transcript read.
   *
   * Distinct from `visible` — that means "on screen now", this means "has never
   * been shown". Restored tabs all mount at boot, and a warm mount costs a
   * `claude` process and a 400-record transcript read each; eight restored tabs
   * must not spawn eight CLIs before the first click. Both costs are paid on
   * first activation instead.
   */
  cold: boolean;
  /** Session uuid to resume; `null` starts a fresh transcript. */
  resume: string | null;
  /** Transcript path backing `resume`, used to render history. */
  resumeFile: string | null;
  onSessionId: (sessionId: string) => void;
  onOpenFile: (path: string) => void;
  /**
   * Technical state of the transport, for the status bar.
   *
   * Separate from the whimsical activity line in the transcript: this is the
   * one that answers "why is nothing moving".
   */
  onPhase: (phase: string) => void;
  /**
   * Coarse state of this chat, for its tab's status dot.
   *
   * Reported by every pane including hidden ones — the whole point is a tab you
   * are not looking at telling you it finished, or that it is blocked on you.
   * Shares the sessions rail's vocabulary so both read from one set of colours.
   */
  onStatus: (status: "active" | "awaiting" | "finished" | "interrupted" | "idle") => void;
  /**
   * Transient notices — spawn failures, stderr, exits.
   *
   * These are about the process, not the conversation, so they belong in the
   * status bar rather than interleaved with what Claude actually said.
   */
  onSystemMessage: (text: string) => void;
  /** Lifts live model/context/cost so the status panel can show them. */
  /** Default permission mode for newly spawned processes. */
  permissionMode: string;
  /** Default `--model` alias for newly spawned processes, or "default" for none. */
  model: string;
  /** Picking a model here becomes the default the next pane spawns with. */
  onModel: (alias: string) => void;
  onStats: (stats: {
    sessionId: string | null;
    model: string | null;
    contextTokens: number;
    costUsd: number | null;
  }) => void;
}

/** Rendered conversation entry, derived from one or more stream-json frames. */
type ChatItem =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; blocks: ContentBlock[] }
  | { kind: "result"; key: string; text: string; costUsd?: number; turns?: number; isError: boolean }
  | { kind: "permission"; key: string; request: PermissionRequest; decided: string | null }
  // A command answered in-app over the control protocol. The item only names
  // the command; the panel fetches its own data, so an answer arriving does not
  // re-render the timeline.
  | { kind: "panel"; key: string; command: NativeCommand; args: string };

/** Everything a control panel needs that is not in its timeline entry. */
interface PanelContext {
  chatId: string;
  cwd: string;
  sessionId: string | null;
  catalog: InitializeResult | null;
  permissionMode: string;
  onModelApplied: (value: string) => void;
  onPermissionModeApplied: (mode: string) => void;
}

const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;

/**
 * Tools whose only effect is to ask the user something.
 *
 * The bridge already answers these itself, so no card should reach this pane;
 * the guard stays because a detached daemon from an older build routes its asks
 * here unchanged. Prompting for them is a double ask — the human answers "may I
 * ask you?" and then the real question.
 */
const AUTO_ALLOWED_TOOLS = new Set(["AskUserQuestion"]);

/** Compact labels so all four modes fit the composer bar as one-click buttons. */
const MODE_LABELS: Record<(typeof PERMISSION_MODES)[number], string> = {
  default: "default",
  acceptEdits: "edits",
  plan: "plan",
  bypassPermissions: "bypass",
};

/**
 * CLI `--model` aliases, plus a sentinel for "don't pass the flag at all".
 *
 * `MODEL_DEFAULT` is not an alias the CLI accepts — it maps to a null
 * `StartOptions.model`, letting the CLI's own configured default win.
 */
const MODEL_DEFAULT = "default";
const MODELS = [MODEL_DEFAULT, "fable", "opus", "sonnet", "haiku"] as const;

/// Conversational entries loaded when resuming. Transcripts reach thousands of
/// records, and only the recent tail is worth rendering.
const HISTORY_LIMIT = 400;

/**
 * Hard cap on rendered items.
 *
 * The list is not virtualized, so every append re-reconciles the whole thing.
 * An unbounded transcript is also what let a runaway render loop accumulate
 * enough state to wedge the app.
 */
const MAX_ITEMS = 1500;

/** Scroll is pinned to the bottom while the user is within this many pixels of it. */
const STICKY_THRESHOLD_PX = 120;

function blocksOf(frame: ClaudeFrame): ContentBlock[] {
  const content = frame.message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

/* The union has an open-ended member, so `block.type === "..."` alone does not
   narrow. These guards check the payload shape as well. */

const isText = (block: ContentBlock): block is TextBlock =>
  block.type === "text" && typeof (block as TextBlock).text === "string";

const isThinking = (block: ContentBlock): block is ThinkingBlock =>
  block.type === "thinking" && typeof (block as ThinkingBlock).thinking === "string";

const isToolUse = (block: ContentBlock): block is ToolUseBlock =>
  block.type === "tool_use" && typeof (block as ToolUseBlock).name === "string";

const isToolResult = (block: ContentBlock): block is ToolResultBlock =>
  block.type === "tool_result" && typeof (block as ToolResultBlock).tool_use_id === "string";

/** Flatten a tool_result payload to displayable text. */
function toolResultText(content: unknown): string {
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

/**
 * Render a tool's input for the IN pane.
 *
 * A shell command is far more readable as the raw script than as a JSON string
 * with escaped newlines, so single-string inputs are unwrapped.
 */
function formatToolInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 1 && typeof input[keys[0]] === "string") {
    return input[keys[0]] as string;
  }
  return Object.entries(input)
    .map(([key, value]) =>
      typeof value === "string" && value.includes("\n")
        ? `${key}:\n${value}`
        : `${key}: ${JSON.stringify(value)}`,
    )
    .join("\n");
}

/* ---------- permission payload rendering ---------- */

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

/**
 * Fields rendered first, in this order, whatever order they arrived in.
 *
 * The bridge carries inputs as `serde_json::Value`, whose default map is a
 * BTreeMap, so every payload reaches the UI alphabetised — which puts a
 * three-line `description` above the `label` it describes. Identity first,
 * prose after; unlisted keys keep their arrival order behind these.
 */
const KEY_ORDER = [
  "header",
  "question",
  "label",
  "name",
  "title",
  "file_path",
  "path",
  "command",
  "pattern",
  "query",
  "url",
  "prompt",
  "multiSelect",
  "description",
];

function orderedEntries(record: Record<string, unknown>): [string, unknown][] {
  const rank = (key: string) => {
    const index = KEY_ORDER.indexOf(key);
    return index === -1 ? KEY_ORDER.length : index;
  };
  // Sort is stable, so same-rank keys stay in the order the payload had them.
  return Object.entries(record).sort(([a], [b]) => rank(a) - rank(b));
}

/** Any JSON value, rendered as labelled structure rather than a JSON dump. */
function PermissionValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="permission-scalar">null</span>;
  }
  if (typeof value === "string") {
    return <span className="permission-text">{value}</span>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="permission-scalar">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    return (
      <ul className="permission-array">
        {value.map((item, index) => (
          <li key={index}>
            <PermissionValue value={item} />
          </li>
        ))}
      </ul>
    );
  }
  const record = asRecord(value);
  if (!record) return <span className="permission-text">{String(value)}</span>;
  return (
    <div className="permission-fields">
      {orderedEntries(record).map(([key, child]) => (
        <div className="permission-field" key={key}>
          <span className="permission-key">{key}</span>
          <PermissionValue value={child} />
        </div>
      ))}
    </div>
  );
}

/**
 * `AskUserQuestion`, rendered as the questions it is actually asking.
 *
 * Returns null on anything that does not match the tool's schema, so a changed
 * payload falls back to the generic renderer instead of showing nothing.
 */
function AskUserQuestionInput({ input }: { input: unknown }) {
  const questions = asRecord(input)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const parsed = questions.map(asRecord);
  if (parsed.some((question) => question === null)) return null;

  return (
    <div className="permission-questions">
      {parsed.map((question, index) => {
        const options = Array.isArray(question!.options) ? question!.options : [];
        return (
          <div className="permission-question" key={index}>
            {asText(question!.header) && (
              <span className="permission-chip">{asText(question!.header)}</span>
            )}
            <div className="permission-prompt">
              {asText(question!.question) ?? "(no question text)"}
            </div>
            <ol className="permission-options">
              {options.map((option, optionIndex) => {
                const record = asRecord(option);
                return (
                  <li key={optionIndex}>
                    {/* Label first: the name of the choice, then what it means. */}
                    <span className="permission-option-label">
                      {asText(record?.label) ?? JSON.stringify(option)}
                    </span>
                    {asText(record?.description) && (
                      <span className="permission-option-note">
                        {asText(record?.description)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
            <div className="permission-note">
              {question!.multiSelect === true ? "pick one or more" : "pick one"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A pending tool call's arguments.
 *
 * A permission decision made on a clipped JSON dump is a decision made on
 * partial information, so the structured view is never scrolled away — only the
 * raw payload, which stays one click behind a disclosure for exact bytes.
 */
const PermissionInput = memo(function PermissionInput({
  toolName,
  input,
}: {
  toolName: string;
  input: unknown;
}) {
  // The prompt for an Edit is the one place a diff is load-bearing: allowing a
  // change means having read it, and `old_string`/`new_string` side by side is
  // not reading it.
  const edit = useMemo(
    () =>
      typeof input === "object" && input !== null
        ? toolDiffLines(toolName, input as Record<string, unknown>)
        : null,
    [input, toolName],
  );
  const filePath =
    typeof input === "object" && input !== null &&
    typeof (input as Record<string, unknown>).file_path === "string"
      ? ((input as Record<string, unknown>).file_path as string)
      : null;
  const known =
    toolName === "AskUserQuestion" ? (
      <AskUserQuestionInput input={input} />
    ) : edit !== null ? (
      <>
        {filePath !== null && <div className="count">{filePath}</div>}
        <ToolDiff lines={edit} />
      </>
    ) : null;
  return (
    <div className="permission-body">
      {known ?? <PermissionValue value={input} />}
      <details className="permission-raw">
        <summary>raw arguments</summary>
        <pre className="selectable">{JSON.stringify(input, null, 2)}</pre>
      </details>
    </div>
  );
});

interface PendingImage {
  id: string;
  mediaType: string;
  data: string;
  width: number;
  height: number;
}

/** Longest tool summary rendered. A whole heredoc script is not a summary. */
const SUMMARY_MAX = 140;

/** One-line gist of a tool call, so a collapsed block still says what it did. */
function toolSummary(name: string, input: Record<string, unknown>): string {
  const pick = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : null);
  const raw =
    pick("file_path") ??
    pick("path") ??
    pick("command") ??
    pick("pattern") ??
    pick("query") ??
    pick("url") ??
    (name === "TodoWrite" ? "update todos" : JSON.stringify(input));
  // Collapse newlines first: a multi-line command rendered on one nowrap line is
  // what blew the chat column past its container and shoved the layout sideways.
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX)}…` : flat;
}

/** Longest line the spinner shows for a tool. */
const SPINNER_DETAIL_MAX = 70;

function clipForSpinner(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SPINNER_DETAIL_MAX ? `${flat.slice(0, SPINNER_DETAIL_MAX)}…` : flat;
}

/**
 * What the spinner says a tool is doing. Bash carries a human-written
 * `description`; everything else falls back to the same gist the collapsed
 * block shows.
 */
function spinnerDetail(name: string, input: Record<string, unknown>): string | null {
  if (typeof input.description === "string" && input.description.trim()) {
    return clipForSpinner(input.description);
  }
  const summary = toolSummary(name, input);
  return summary ? clipForSpinner(summary) : null;
}

/**
 * Best-effort gist of a tool input that is still streaming as partial JSON.
 * The value regex only matches complete escape pairs, so the slice always
 * parses; parse failures still fall back to the raw match.
 */
function previewFromPartialJson(partial: string): string | null {
  const match = partial.match(
    /"(?:description|command|file_path|path|pattern|query|url|prompt)"\s*:\s*"((?:[^"\\]|\\.)*)/,
  );
  if (!match) return null;
  let text: string;
  try {
    text = JSON.parse(`"${match[1]}"`) as string;
  } catch {
    text = match[1];
  }
  return text.trim() ? clipForSpinner(text) : null;
}

/** One-line gist of a frame for the session debug log. */
function frameLabel(frame: ClaudeFrame): string {
  switch (frame.type) {
    case "system":
      return `system · ${frame.subtype ?? "?"}`;
    case "assistant": {
      const parts = blocksOf(frame).map((block) =>
        isToolUse(block) ? `tool_use(${block.name})` : block.type,
      );
      return `assistant · ${parts.join("+") || "empty"}`;
    }
    case "user": {
      const results = blocksOf(frame).filter(isToolResult);
      return results.length > 0 ? `tool_result ×${results.length}` : "user echo";
    }
    case "stream_event": {
      const event = frame.event as { type?: string; delta?: { type?: string } } | undefined;
      return [event?.type, event?.delta?.type].filter(Boolean).join(" · ") || "stream_event";
    }
    case "result":
      return `result · ${frame.subtype ?? "done"}${frame.is_error ? " · error" : ""}`;
    case "control_response": {
      const envelope = frame.response as { subtype?: string; request_id?: string } | undefined;
      return `control_response · ${envelope?.subtype ?? "?"}`;
    }
    default:
      return frame.type;
  }
}

/** The tool call the CLI is waiting on, and since when. */
interface PendingTool {
  name: string;
  detail: string | null;
  /** Null while the model is still typing the call; set once execution starts. */
  startedAt: number | null;
}

const ToolBlock = memo(function ToolBlock({
  block,
  result,
  onOpenFile,
}: {
  block: ToolUseBlock;
  result: { text: string; isError: boolean } | undefined;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Blocks are appended once and never mutated, so this survives re-renders
  // caused by a result arriving — the stringify/regex work runs once per block.
  const summary = useMemo(() => toolSummary(block.name, block.input), [block]);
  // An edit is a diff, not a pair of opaque strings: `old_string`/`new_string`
  // side by side made a two-line change unreadable. Null for every other tool,
  // which keeps the raw dump for anything this cannot render faithfully.
  const diffLines = useMemo(() => toolDiffLines(block.name, block.input), [block]);
  const filePath =
    typeof block.input.file_path === "string" ? (block.input.file_path as string) : null;

  return (
    <div className="tool-block" data-error={result?.isError ?? false}>
      <div className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="twisty">{open ? "▾" : "▸"}</span>
        <span className="tool-name">{block.name}</span>
        <span
          className="tool-summary"
          onClick={(event) => {
            if (!filePath) return;
            // Clickable file references are the main thing a terminal cannot do.
            event.stopPropagation();
            onOpenFile(filePath);
          }}
          style={filePath ? { textDecoration: "underline", cursor: "pointer" } : undefined}
        >
          {summary}
        </span>
      </div>
      {open && (
        <>
          <div className="tool-io">
            <span className="io-tag">IN</span>
            {diffLines === null ? (
              <pre className="selectable">{formatToolInput(block.input)}</pre>
            ) : (
              <ToolDiff lines={diffLines} />
            )}
          </div>
          {result && (
            <div className="tool-io" data-error={result.isError}>
              <span className="io-tag">OUT</span>
              <pre className="selectable">{result.text || "(no output)"}</pre>
            </div>
          )}
        </>
      )}
    </div>
  );
});

/**
 * The chat pane: a `claude` process rendered as a conversation.
 *
 * Frames arrive from Rust untouched, so anything the CLI emits is representable
 * here; unknown block types fall through to a JSON dump rather than vanishing.
 */
/**
 * Turn stored transcript records into rendered items.
 *
 * Transcript records carry the same `type`/`message` shape as live stream-json
 * frames, so one mapping serves both. Tool results are hoisted out separately
 * because they arrive as `user` records referencing an earlier `tool_use`.
 */
function hydrate(
  records: ClaudeFrame[],
  generation: number,
): {
  items: ChatItem[];
  toolResults: Record<string, { text: string; isError: boolean }>;
} {
  const items: ChatItem[] = [];
  const toolResults: Record<string, { text: string; isError: boolean }> = {};
  // Namespaced by generation: a second hydration must not reuse "h0", "h1"…
  let key = 0;
  const historyKey = () => `h${generation}-${key++}`;

  for (const record of records) {
    const blocks = blocksOf(record);
    if (record.type === "assistant") {
      if (blocks.length > 0) items.push({ kind: "assistant", key: historyKey(), blocks });
      continue;
    }
    if (record.type !== "user") continue;

    const results = blocks.filter(isToolResult);
    if (results.length > 0) {
      for (const result of results) {
        toolResults[result.tool_use_id] = {
          text: toolResultText(result.content),
          isError: Boolean(result.is_error),
        };
      }
      continue; // Tool-result echo, not something the human typed.
    }
    const text = blocks.filter(isText).map((b) => b.text).join("");
    if (text.trim()) items.push({ kind: "user", key: historyKey(), text });
  }

  return { items, toolResults };
}

/**
 * One row on the timeline rail.
 *
 * Each tool call is its own entry rather than nested inside an assistant
 * bubble, so the rail reads as a sequence of actions — matching how the
 * official Claude Code plugin renders a turn.
 */
type TimelineEntry = { key: string; state?: string } & (
  | { kind: "user"; text: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; block: ToolUseBlock }
  | { kind: "unknown"; block: ContentBlock }
  | { kind: "permission"; request: PermissionRequest; decided: string | null }
  | { kind: "panel"; command: NativeCommand; args: string }
  | {
      kind: "result";
      text: string;
      isError: boolean;
      turns?: number;
      costUsd?: number;
    }
);

/**
 * A row's text, for "Copy Message".
 *
 * Only the rows that are prose or a payload have one; a permission card and a
 * turn summary are UI, not content, so they return null and the item is dropped
 * from the menu rather than copying a rendering of itself.
 */
function entryText(entry: TimelineEntry): string | null {
  switch (entry.kind) {
    case "user":
    case "text":
    case "thinking":
      return entry.text;
    case "tool":
      return JSON.stringify(entry.block.input, null, 2);
    case "unknown":
      return JSON.stringify(entry.block, null, 2);
    case "result":
      return entry.text || null;
    default:
      return null;
  }
}

/** Flatten chat items into rail entries, one per visible action. */
function toTimeline(
  items: ChatItem[],
  toolResults: Record<string, { text: string; isError: boolean }>,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const item of items) {
    switch (item.kind) {
      case "user":
        entries.push({ kind: "user", key: item.key, text: item.text, state: "user" });
        break;
      case "assistant":
        item.blocks.forEach((block, index) => {
          const key = `${item.key}-${index}`;
          if (isText(block)) {
            if (block.text.trim()) {
              entries.push({ kind: "text", key, text: block.text, state: "assistant" });
            }
          } else if (isThinking(block)) {
            if (block.thinking.trim()) {
              entries.push({ kind: "thinking", key, text: block.thinking, state: "thinking" });
            }
          } else if (isToolUse(block)) {
            const result = toolResults[block.id];
            entries.push({
              kind: "tool",
              key: block.id ?? key,
              block,
              // No result yet means the tool is still running — the dot is the
              // only place that distinguishes "working" from "finished".
              state: result ? (result.isError ? "error" : "done") : "running",
            });
          } else {
            entries.push({ kind: "unknown", key, block });
          }
        });
        break;
      case "permission":
        entries.push({
          kind: "permission",
          key: item.key,
          request: item.request,
          decided: item.decided,
          state: item.decided ? (item.decided === "deny" ? "error" : "done") : "waiting",
        });
        break;
      case "panel":
        entries.push({
          kind: "panel",
          key: item.key,
          command: item.command,
          args: item.args,
          state: "done",
        });
        break;
      case "result":
        entries.push({
          kind: "result",
          key: item.key,
          text: item.text,
          isError: item.isError,
          turns: item.turns,
          costUsd: item.costUsd,
          state: item.isError ? "error" : "done",
        });
        break;
    }
  }
  return entries;
}

/**
 * A typed message, or the echo of a slash command the CLI ran.
 *
 * Transcripts record a ran command as `<command-name>` with its output in
 * `<local-command-stdout>`, so a resumed session would otherwise show raw XML
 * in the middle of the conversation.
 */
const UserMessage = memo(function UserMessage({ text }: { text: string }) {
  const echo = useMemo(() => parseCommandEcho(text), [text]);
  if (!echo) return <div className="bubble-user text">{text}</div>;
  return (
    <div className="bubble-user">
      {echo.name && (
        <div className="command-echo">
          <span className="command-chip">{echo.name}</span>
          {echo.args && <span className="command-args">{echo.args}</span>}
        </div>
      )}
      {echo.rest && <div className="text">{echo.rest}</div>}
      {echo.stdout.map((chunk, index) => (
        <pre className="command-output selectable" key={`out-${index}`}>
          {chunk}
        </pre>
      ))}
      {echo.stderr.map((chunk, index) => (
        <pre className="command-output selectable" data-error="true" key={`err-${index}`}>
          {chunk}
        </pre>
      ))}
    </div>
  );
});

/**
 * The rendered timeline rows, split out of ChatPane and memoized so composer
 * keystrokes — which only touch draft state — do not re-reconcile up to
 * MAX_ITEMS rows on every character.
 */
const Timeline = memo(function Timeline({
  entries,
  toolResults,
  onOpenFile,
  onDecide,
  panelContext,
  logMenu,
}: {
  entries: TimelineEntry[];
  toolResults: Record<string, { text: string; isError: boolean }>;
  onOpenFile: (path: string) => void;
  onDecide: (
    request: PermissionRequest,
    behavior: "allow" | "deny",
    always?: boolean,
  ) => Promise<void>;
  panelContext: PanelContext;
  /** The chat-wide entries a row's menu ends with. */
  logMenu: () => MenuEntry[];
}) {
  const menu = useMenu();
  return (
    <>
      {entries.map((entry) => (
        <div
          key={entry.key}
          className="timeline-row"
          data-kind={entry.kind}
          onContextMenu={(event) => {
            const text = entryText(entry);
            menu.openContextMenu(event, [
              text && { label: "Copy Message", run: () => void copyText(text) },
              "separator",
              "editing",
              "separator",
              ...logMenu(),
            ]);
          }}
        >
          <span className="timeline-dot" data-state={entry.state ?? ""} />
          <div className="timeline-body">
            {entry.kind === "user" && <UserMessage text={entry.text} />}

            {entry.kind === "panel" && (
              <ControlPanel
                chatId={panelContext.chatId}
                command={entry.command}
                args={entry.args}
                cwd={panelContext.cwd}
                sessionId={panelContext.sessionId}
                catalog={panelContext.catalog}
                permissionMode={panelContext.permissionMode}
                onModelApplied={panelContext.onModelApplied}
                onPermissionModeApplied={panelContext.onPermissionModeApplied}
              />
            )}

            {entry.kind === "text" && (
              <Markdown onOpenFile={onOpenFile}>{entry.text}</Markdown>
            )}

            {entry.kind === "thinking" && (
              <div className="thinking-block">{entry.text}</div>
            )}

            {entry.kind === "tool" && (
              <ToolBlock
                block={entry.block}
                result={toolResults[entry.block.id]}
                onOpenFile={onOpenFile}
              />
            )}

            {entry.kind === "unknown" && (
              <pre className="tool-block">{JSON.stringify(entry.block, null, 2)}</pre>
            )}

            {entry.kind === "permission" && (
              <div className="permission-card" data-decided={entry.decided ?? ""}>
                <div className="permission-head">
                  <span className="permission-tool">{entry.request.toolName}</span>
                  <span className="permission-ask">
                    {AUTO_ALLOWED_TOOLS.has(entry.request.toolName)
                      ? "wants to ask you"
                      : "wants to run"}
                  </span>
                </div>
                <PermissionInput
                  toolName={entry.request.toolName}
                  input={entry.request.input}
                />
                {entry.decided ? (
                  <div className="permission-decided">{entry.decided}ed</div>
                ) : (
                  // One contiguous group: a Deny shoved to the far edge reads as
                  // belonging to something else.
                  <div className="permission-actions">
                    <button
                      className="primary-button"
                      onClick={() => void onDecide(entry.request, "allow")}
                    >
                      Allow once
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => void onDecide(entry.request, "allow", true)}
                    >
                      Always allow {entry.request.toolName}
                    </button>
                    <button
                      className="danger-button"
                      onClick={() => void onDecide(entry.request, "deny")}
                    >
                      Deny
                    </button>
                  </div>
                )}
              </div>
            )}

            {entry.kind === "result" && (
              <div className="turn-result" data-error={entry.isError}>
                <span>{entry.isError ? "error" : "turn complete"}</span>
                {entry.turns !== undefined && <span>{entry.turns} turns</span>}
                {entry.costUsd !== undefined && <span>${entry.costUsd.toFixed(4)}</span>}
                {entry.isError && entry.text && (
                  <div className="text" style={{ color: "var(--red)" }}>
                    {entry.text}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
    </>
  );
});

export const ChatPane = memo(function ChatPane({
  chatId,
  cwd,
  visible,
  cold,
  resume,
  resumeFile,
  onSessionId,
  onOpenFile,
  onSystemMessage,
  onPhase,
  onStatus,
  onStats,
  permissionMode: defaultPermissionMode,
  model: defaultModelAlias,
  onModel,
}: ChatPaneProps) {
  const menu = useMenu();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [toolResults, setToolResults] = useState<Record<string, { text: string; isError: boolean }>>(
    {},
  );
  const [draft, setDraft] = useState("");
  /** Images pasted into the composer, sent as content blocks alongside the text. */
  const [attachments, setAttachments] = useState<PendingImage[]>([]);
  const [running, setRunning] = useState(false);
  const [alive, setAlive] = useState(false);
  /**
   * Whether this pane has earned its process.
   *
   * A cold-restored pane spawns nothing and reads no transcript until it is
   * first shown, and this latch only ever goes false -> true. Deriving it from
   * `visible` instead would re-run the mount effect on every hide/show — whose
   * cleanup retires and detaches the live instance, and whose re-run wipes and
   * re-hydrates the transcript.
   */
  const [warmed, setWarmed] = useState(!cold);
  const [permissionMode, setPermissionMode] = useState<string>(defaultPermissionMode);
  /** Tools the user chose to always allow, for this pane's lifetime. */
  const alwaysAllowRef = useRef<Set<string>>(new Set());
  /**
   * Mode the live process was actually spawned with.
   *
   * `permissionMode` used to sit in `start`'s dependencies, so picking a mode
   * tore down the child and wiped the transcript on the spot — the opposite of
   * the control's own "applies on restart" tooltip.
   */
  const permissionModeRef = useRef(defaultPermissionMode);
  const [spawnedPermissionMode, setSpawnedPermissionMode] = useState(defaultPermissionMode);
  /**
   * Chosen `--model` alias, and the one the live process actually got.
   *
   * Held in a ref for the same reason as the permission mode: the alias arms the
   * next restart instead of tearing down the running child.
   */
  const [modelAlias, setModelAlias] = useState<string>(defaultModelAlias);
  const modelAliasRef = useRef(defaultModelAlias);
  const [spawnedModelAlias, setSpawnedModelAlias] = useState(defaultModelAlias);
  const [sessionId, setSessionId] = useState<string | null>(resume);
  const [costUsd, setCostUsd] = useState<number | null>(null);
  const [model, setModel] = useState<string | null>(null);
  /**
   * What the transport is doing right now, in plain technical terms.
   *
   * A cold pane rests at "not started" so the status bar says why nothing is
   * moving; the first spawn overwrites it the same way it overwrites "idle".
   */
  const [phase, setPhase] = useState(cold ? "not started" : "idle");
  /** The tool call whose result the CLI is still waiting on. */
  const [pendingTool, setPendingTool] = useState<PendingTool | null>(null);
  /** What the /proc probe says is executing under the CLI right now. */
  const [toolActivity, setToolActivity] = useState<string | null>(null);
  /** Accumulates input_json_delta while the model types a tool call. */
  const partialToolRef = useRef<{ name: string; json: string } | null>(null);
  // Settled `assistant` frames carry thinking blocks with `thinking: ""` — the
  // text only ever arrives as stream deltas, so it is buffered by block index
  // here and grafted back on when the frame lands.
  const thinkingTextRef = useRef<Map<number, string>>(new Map());
  /** When the current turn started, for the elapsed counter. */
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  /** Window the next request will carry, from the newest assistant usage block. */
  const [contextTokens, setContextTokens] = useState(0);
  /**
   * The CLI's own answer to `initialize`: its slash-command catalog, model
   * list, agents and account. Null until the request lands, which is the only
   * state the composer menu and the panels have to tolerate.
   */
  const [catalog, setCatalog] = useState<InitializeResult | null>(null);
  /** Caret offset in the composer, which is what decides whether a menu opens. */
  const [caret, setCaret] = useState(0);
  /** Highlighted row in the autocomplete popup. */
  const [menuCursor, setMenuCursor] = useState(0);
  /** Results for an `@` mention, from mangouste's own file index. */
  const [fileMatches, setFileMatches] = useState<string[]>([]);

  /** Spawn this pane is currently bound to; events from older spawns are dropped. */
  const instanceRef = useRef<number | null>(null);
  /** In-flight start, so teardown can stop exactly the spawn it created. */
  const startRef = useRef<Promise<number | null>>(Promise.resolve(null));
  /**
   * Spawns this pane has deliberately killed.
   *
   * A stopped process emits its exit event asynchronously, and that can land
   * while `instanceRef` still points at it — before the replacement's start
   * resolves. Without this the pane reports "claude exited" for a process it
   * killed on purpose.
   */
  const retiredRef = useRef<Set<number>>(new Set());
  /**
   * Bumped on every `start()`.
   *
   * The effect is invoked twice under StrictMode and re-runs on every restart,
   * so without this both async hydrations prepend and the whole transcript is
   * rendered twice, with colliding React keys.
   */
  const startGenerationRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const stickyRef = useRef(true);
  const sequenceRef = useRef(0);
  const nextKey = () => `item-${sequenceRef.current++}`;

  /**
   * Latest resume target, read at spawn time rather than closed over.
   *
   * When the CLI announces the uuid for a fresh session, App writes it back
   * into `resume` — and if that changed `spawn`'s identity, the mount effect
   * would tear the pane down mid-turn: the cleanup retired the live instance,
   * the respawn wiped the transcript, and claude_start re-attached to the very
   * instance that was just retired, so every later frame was dropped.
   */
  const resumeRef = useRef(resume);
  const resumeFileRef = useRef(resumeFile);
  /** Latest callbacks, so the frame handler and its subscriptions stay stable. */
  const onSessionIdRef = useRef(onSessionId);
  const onSystemMessageRef = useRef(onSystemMessage);
  useEffect(() => {
    resumeRef.current = resume;
    resumeFileRef.current = resumeFile;
    onSessionIdRef.current = onSessionId;
    onSystemMessageRef.current = onSystemMessage;
  });
  /*
   * The mount-time snapshot in permissionModeRef/modelAliasRef is fine for a
   * warm pane — it spawns immediately. A cold pane can sit for minutes while a
   * pick in another pane moves App's defaults, and its eventual first spawn
   * must use the defaults of now, not of boot. Sync only while no spawn has
   * ever been asked for: past that point this is exactly the
   * teardown-on-mode-change bug described above permissionModeRef, and it would
   * clobber a mode the user armed in this pane's own strip. State moves with
   * the refs, or the mode switches would highlight a choice the spawn ignores.
   * This effect sits above the mount effect, so on the commit that warms the
   * latch it still runs before the first start().
   */
  useEffect(() => {
    if (startGenerationRef.current !== 0) return;
    permissionModeRef.current = defaultPermissionMode;
    setPermissionMode(defaultPermissionMode);
    setSpawnedPermissionMode(defaultPermissionMode);
    modelAliasRef.current = defaultModelAlias;
    setModelAlias(defaultModelAlias);
    setSpawnedModelAlias(defaultModelAlias);
  }, [defaultPermissionMode, defaultModelAlias]);
  /** Mirrors `sessionId` state for the stable frame handler. */
  const sessionIdRef = useRef<string | null>(resume);

  const appendItem = useCallback((item: ChatItem) => {
    setItems((current) => {
      const next = [...current, item];
      return next.length > MAX_ITEMS ? next.slice(next.length - MAX_ITEMS) : next;
    });
  }, []);

  // Report the phase upward whenever it moves, but only for the front tab.
  useEffect(() => {
    onPhase(pendingTool ? `${phase} · ${pendingTool.name}` : phase);
  }, [onPhase, phase, pendingTool]);

  // Phase moves are the debug log's skeleton: they bound every silence.
  useEffect(() => {
    logDebug(chatId, "phase", phase);
  }, [chatId, phase]);

  /** An undecided prompt is the one state that needs a human right now. */
  const awaitingPermission = useMemo(
    () => items.some((item) => item.kind === "permission" && item.decided === null),
    [items],
  );

  const coarseStatus = useMemo(() => {
    if (awaitingPermission) return "awaiting" as const;
    if (running) return "active" as const;
    // `alive` is false before the first start resolves as well as after an exit,
    // so a pane that has not spawned yet must not read as a dead one. "not
    // started" is the cold pane's resting phase and belongs to the same family.
    if (!alive) {
      return phase === "idle" ||
        phase === "not started" ||
        phase === "attaching" ||
        phase === "starting claude"
        ? ("idle" as const)
        : ("interrupted" as const);
    }
    return "finished" as const;
  }, [awaitingPermission, running, alive, phase]);

  useEffect(() => {
    onStatus(coarseStatus);
  }, [onStatus, coarseStatus]);

  /**
   * Time parked on a human is not time the agent spent working, so it is
   * subtracted from the elapsed counter when the last ask is answered. The
   * spinner is hidden for the duration as well — a counter ticking up while
   * nothing is running claims work that is not happening.
   */
  const blockedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (awaitingPermission) {
      // Overlapping asks share one window: first ask in, last decision out.
      if (blockedAtRef.current === null) blockedAtRef.current = Date.now();
      return;
    }
    const blockedAt = blockedAtRef.current;
    if (blockedAt === null) return;
    blockedAtRef.current = null;
    const blockedMs = Date.now() - blockedAt;
    setTurnStartedAt((at) => (at === null ? at : at + blockedMs));
    setPendingTool((tool) =>
      tool === null || tool.startedAt === null
        ? tool
        : { ...tool, startedAt: tool.startedAt + blockedMs },
    );
  }, [awaitingPermission]);

  /* ---------- process lifecycle ---------- */

  /**
   * Bring this pane's process up and bind to it.
   *
   * `mode: "attach"` binds to the live process the backend already holds under
   * this chat id and only spawns when there is none, so a real remount — a
   * window reload, a restart — comes back to the same session. Tab and repo
   * switches are free for a different reason: nothing unmounts for them, so
   * this never runs.
   * `mode: "restart"` always kills and respawns, for the restart control and for
   * applying a changed permission mode.
   */
  const spawn = useCallback(
    async (mode: "attach" | "restart") => {
    setItems([]);
    setToolResults({});
    setCostUsd(null);
    setModel(null);
    setContextTokens(0);
    // Whatever was asked of the outgoing process will never be answered.
    abortControl(chatId, "chat restarted");
    setCatalog(null);
    const generation = (startGenerationRef.current += 1);
    const resumeTarget = resumeRef.current;
    const resumeFilePath = resumeFileRef.current;

    // Anything currently attached is about to be replaced by claude_start.
    if (instanceRef.current !== null) retiredRef.current.add(instanceRef.current);

    // Render the stored transcript first so a resumed session is not a blank
    // pane while the process boots. This needs the transcript PATH — passing the
    // session uuid here silently resolved to a non-existent relative file.
    if (resumeFilePath) {
      void readSessionTranscript(resumeFilePath, HISTORY_LIMIT)
        .then((records) => {
          // A newer start() already owns this pane; drop these results.
          if (generation !== startGenerationRef.current) return;
          const { items: history, toolResults: historyResults } = hydrate(records, generation);
          if (history.length === 0) return;
          setItems((current) => [...history, ...current]);
          setToolResults((current) => ({ ...historyResults, ...current }));
        })
        .catch((e) => {
          if (generation !== startGenerationRef.current) return;
          // Surfaced rather than swallowed: a silent catch here is what made the
          // blank-on-resume bug invisible.
          onSystemMessageRef.current(`Could not load transcript history: ${e}`);
        });
    }

    setPhase(resumeTarget ? "attaching" : "starting claude");
    const spawnMode = permissionModeRef.current;
    setSpawnedPermissionMode(spawnMode);
    const spawnModelAlias = modelAliasRef.current;
    setSpawnedModelAlias(spawnModelAlias);
    const options = {
      chatId,
      cwd,
      resume: resumeTarget,
      permissionMode: spawnMode,
      model: spawnModelAlias === MODEL_DEFAULT ? null : spawnModelAlias,
      debug: cliDebugEnabled(),
    };
    const attach = mode === "attach" ? claudeStart : claudeRestart;
    const pending = attach(options)
      .then((status) => {
        // A newer start() already owns this pane; leave its bindings alone.
        if (generation !== startGenerationRef.current) return status.instance;
        instanceRef.current = status.instance;
        // Attaching can hand back an instance a previous teardown retired —
        // it is live again, and must not be filtered by isCurrent forever.
        retiredRef.current.delete(status.instance);
        setAlive(status.alive);
        setPhase(status.running ? "receiving" : "ready");
        if (status.running) setTurnStartedAt(Date.now());
        // A turn already in flight in the backend is still running. Without this
        // an attached pane offers an input box for a session mid-answer.
        setRunning(status.running);
        // The live process may predate this pane, so the mode it was actually
        // spawned with is the backend's answer, not our local guess.
        if (status.permissionMode) setSpawnedPermissionMode(status.permissionMode);
        // Announce the client and read back its catalog. Optional on the wire
        // and safe on an attach — a process that is already initialized answers
        // with its current state instead of re-running session setup — so both
        // paths take it. Failure only costs the autocomplete menu its CLI half.
        void controlInitialize(chatId)
          .then((result) => {
            if (generation !== startGenerationRef.current) return;
            setCatalog(result);
            logDebug(chatId, "control", `initialize · ${result.commands.length} commands`, result);
          })
          .catch((e: unknown) => {
            if (generation !== startGenerationRef.current) return;
            logDebug(chatId, "control", `initialize failed: ${String(e)}`);
          });
        if (status.attached) {
          onSystemMessageRef.current(`attached to a running session (pid ${status.pid ?? "?"})`);
        }
        // Prompts raised while nothing was watching. Carried in the reply rather
        // than broadcast, so they land exactly once, here.
        for (const request of status.pendingPermissions ?? []) {
          if (
            AUTO_ALLOWED_TOOLS.has(request.toolName) ||
            alwaysAllowRef.current.has(request.toolName)
          ) {
            void permissionRespond(request.id, "allow");
            continue;
          }
          appendItem({ kind: "permission", key: nextKey(), request, decided: null });
        }
        return status.instance;
      })
      .catch((e) => {
        if (generation !== startGenerationRef.current) return null;
        setAlive(false);
        setPhase("failed to start");
        onSystemMessageRef.current(`Failed to start claude: ${e}`);
        return null;
      });
    startRef.current = pending;
    await pending;
    // `permissionMode` and `resume` are deliberately absent from the deps: both
    // are read through refs at spawn time, so changing them never tears down the
    // live process — the mode arms the next restart, and the resume write-back
    // (null -> uuid, from this pane's own onSessionId) is already attached.
    },
    [chatId, cwd, appendItem],
  );

  const start = useCallback(() => spawn("attach"), [spawn]);
  /**
   * On a pane that never spawned, restart IS the first start: there is no
   * process to kill, so warming the latch lets the mount effect run the one
   * attach. Calling spawn("restart") here instead would race the visibility
   * flip — restart spawns generation N, the flip spawns N+1, and the pane is
   * wiped and re-hydrated twice for one intent.
   */
  const restart = useCallback(() => {
    if (!warmed) {
      setWarmed(true);
      return Promise.resolve();
    }
    return spawn("restart");
  }, [spawn, warmed]);

  useEffect(() => {
    // A cold pane owes nothing yet: no spawn, no transcript read — and no
    // cleanup, or unmounting a never-shown pane would resolve a pending it
    // never created and detach a process it never started. The latch flipping
    // true re-runs this effect, and that one run is the fresh-mount path.
    if (!warmed) return;
    void start();
    const pending = startRef.current;
    return () => {
      // Detach, never kill. A pane unmounts for reasons that have nothing to do
      // with the user being finished — window close, a remount — and the backend
      // keeps the process running for all of them. Closing the tab is the one
      // teardown that does mean "done", and App's closeTab kills it there.
      //
      // Still retire the instance so late frames from it are dropped by this
      // teardown's own listeners rather than rendered into a replacement pane.
      void pending.then((instance) => {
        if (instance === null) return;
        retiredRef.current.add(instance);
        void claudeDetach(chatId);
      });
    };
  }, [start, chatId, warmed]);

  // First show is what pays for the process. The latch is also warmed when the
  // parent stops calling the pane cold — App drops a tab from its cold set the
  // moment it becomes active, and that prop can land before `visible` does.
  // Both firing in one commit is fine: setting an already-true latch is a no-op,
  // so there is still exactly one spawn.
  useEffect(() => {
    if (visible || !cold) setWarmed(true);
  }, [visible, cold]);

  /* ---------- frame handling ---------- */

  // Everything mutable is read through refs, so this callback — and the Tauri
  // subscriptions hanging off it — keeps one identity for the pane's lifetime.
  // When it depended on the `onSessionId` prop and `sessionId` state, every App
  // render re-ran the subscription effect, and frames arriving in the async
  // unsubscribe/resubscribe gap were silently dropped.
  const handleFrame = useCallback(
    (frame: ClaudeFrame) => {
      // Everything the transport says lands in the debug log, deltas included;
      // consecutive identical stream events coalesce in the store.
      logDebug(chatId, frame.type === "stream_event" ? "stream" : "frame", frameLabel(frame), frame);
      // An answer to one of this pane's control requests is not conversation:
      // the control channel resolves the promise waiting on it and nothing
      // downstream needs to see the frame.
      if (resolveControlResponse(chatId, frame)) return;
      if (frame.session_id && frame.session_id !== sessionIdRef.current) {
        const resumeTarget = resumeRef.current;
        // A resume that lands on a different id means the CLI could not reopen
        // the transcript and silently started a new one. Worth saying out loud.
        if (resumeTarget && frame.session_id !== resumeTarget && sessionIdRef.current === resumeTarget) {
          onSystemMessageRef.current(`Resume of ${resumeTarget.slice(0, 8)} failed; started new session ${frame.session_id.slice(0, 8)}.`);
        }
        sessionIdRef.current = frame.session_id;
        setSessionId(frame.session_id);
        onSessionIdRef.current(frame.session_id);
      }

      switch (frame.type) {
        case "system":
          if (frame.subtype === "init") {
            onSystemMessageRef.current(`session ${String(frame.session_id ?? "").slice(0, 8)} · ${cwd}`);
          }
          return;

        case "assistant": {
          setRunning(true);
          // A tool_use block means the CLI now waits on that tool; nothing else
          // is written to the transcript until it returns, which is exactly the
          // silence that looks like a hang. Execution starts at this settled
          // frame, so the per-tool clock starts here too.
          const toolUses = blocksOf(frame).filter(isToolUse);
          const toolUse = toolUses[0];
          partialToolRef.current = null;
          setPhase(toolUse ? "running tool" : "receiving");
          setPendingTool(
            toolUse
              ? {
                  name:
                    toolUses.length > 1
                      ? `${toolUse.name} +${toolUses.length - 1}`
                      : toolUse.name,
                  detail: spinnerDetail(toolUse.name, toolUse.input),
                  startedAt: Date.now(),
                }
              : null,
          );
          if (frame.message?.model) setModel(frame.message.model);
          const usage = frame.message?.usage;
          if (usage) {
            // Context occupancy = everything that call carried, cache included.
            setContextTokens(
              (usage.input_tokens ?? 0) +
                (usage.cache_read_input_tokens ?? 0) +
                (usage.cache_creation_input_tokens ?? 0) +
                (usage.output_tokens ?? 0),
            );
          }
          // Stream indices count across a whole API message, but the CLI can
          // split that message into several `assistant` frames whose block
          // arrays each restart at 0 — so buffered thinking is consumed in
          // index order rather than matched by position.
          const buffered = thinkingTextRef.current;
          const pending = [...buffered.keys()].sort((a, b) => a - b);
          const blocks = blocksOf(frame).map((block) => {
            if (!isThinking(block) || block.thinking) return block;
            const index = pending.shift();
            if (index === undefined) return block;
            const streamed = buffered.get(index) ?? "";
            buffered.delete(index);
            return streamed ? { ...block, thinking: streamed } : block;
          });
          if (blocks.length > 0) {
            appendItem({ kind: "assistant", key: nextKey(), blocks });
          }
          return;
        }

        case "user": {
          // User frames echoed by the CLI carry tool results, not typed input.
          const blocks = blocksOf(frame);
          const results = blocks.filter(isToolResult);
          if (results.length > 0) {
            setPhase("receiving");
            setPendingTool(null);
            setToolActivity(null);
            setToolResults((current) => {
              const next = { ...current };
              for (const result of results) {
                next[result.tool_use_id] = {
                  text: toolResultText(result.content),
                  isError: Boolean(result.is_error),
                };
              }
              return next;
            });
          }
          return;
        }

        case "result":
          setRunning(false);
          setPhase("ready");
          setPendingTool(null);
          setToolActivity(null);
          partialToolRef.current = null;
          setTurnStartedAt(null);
          thinkingTextRef.current = new Map();
          if (typeof frame.total_cost_usd === "number") setCostUsd(frame.total_cost_usd);
          appendItem({
            kind: "result",
            key: nextKey(),
            text: frame.result ?? frame.subtype ?? "done",
            costUsd: frame.total_cost_usd,
            turns: frame.num_turns,
            isError: Boolean(frame.is_error),
          });
          return;

        case "stream_event": {
          // Deltas drive the spinner only; the settled `assistant` frame still
          // carries everything rendered into the transcript.
          if (frame.parent_tool_use_id) return; // Subagent internals.
          const event = frame.event as
            | {
                type?: string;
                index?: number;
                content_block?: { type?: string; name?: string };
                delta?: Record<string, unknown>;
              }
            | undefined;
          if (!event) return;
          if (event.type === "content_block_start") {
            if (event.content_block?.type === "thinking" && typeof event.index === "number") {
              thinkingTextRef.current.set(event.index, "");
            }
            if (
              event.content_block?.type === "tool_use" &&
              typeof event.content_block.name === "string"
            ) {
              partialToolRef.current = { name: event.content_block.name, json: "" };
              setPhase("preparing tool");
              setPendingTool({
                name: event.content_block.name,
                detail: null,
                startedAt: null,
              });
            }
            return;
          }
          if (event.type !== "content_block_delta") return;
          const delta = event.delta ?? {};
          if (delta.type === "thinking_delta") {
            setPhase("thinking");
            if (typeof delta.thinking === "string" && typeof event.index === "number") {
              const buffered = thinkingTextRef.current.get(event.index) ?? "";
              thinkingTextRef.current.set(event.index, buffered + delta.thinking);
            }
          } else if (delta.type === "text_delta") {
            setPhase("writing");
          } else if (
            delta.type === "input_json_delta" &&
            typeof delta.partial_json === "string"
          ) {
            const partial = partialToolRef.current;
            if (!partial) return;
            partial.json += delta.partial_json;
            const preview = previewFromPartialJson(partial.json);
            if (preview) {
              // Functional update so an unchanged preview never re-renders.
              setPendingTool((current) =>
                current && current.detail === preview
                  ? current
                  : { name: partial.name, detail: preview, startedAt: current?.startedAt ?? null },
              );
            }
          }
          return;
        }

        default:
          // Unknown future frame types are ignored rather than rendered
          // half-formed.
          return;
      }
    },
    [appendItem, cwd, chatId],
  );

  /** An event belongs to this pane only if its spawn is live and not retired. */
  const isCurrent = useCallback(
    (instance: number) =>
      instance === instanceRef.current && !retiredRef.current.has(instance),
    [],
  );

  const decide = useCallback(
    async (request: PermissionRequest, behavior: "allow" | "deny", always = false) => {
      logDebug(chatId, "permission", `${behavior} · ${request.toolName}${always ? " (always)" : ""}`);
      if (always) alwaysAllowRef.current.add(request.toolName);
      try {
        await permissionRespond(request.id, behavior, {
          message: behavior === "deny" ? "Denied by the user in mangouste" : undefined,
        });
      } catch {
        // The request may have already timed out; the card still resolves.
      }
      setPhase("receiving");
      setItems((current) =>
        current.map((item) =>
          item.kind === "permission" && item.request.id === request.id
            ? { ...item, decided: behavior }
            : item,
        ),
      );
    },
    [chatId],
  );

  useEffect(() => {
    const subscriptions = [
      onClaudeMessage((event) => {
        if (event.chatId === chatId && isCurrent(event.instance)) {
          handleFrame(event.payload);
        }
      }),
      onClaudeStderr((event) => {
        if (event.chatId === chatId && isCurrent(event.instance)) {
          logDebug(chatId, "stderr", event.line);
          onSystemMessageRef.current(event.line);
        }
      }),
      onClaudeDebug((event) => {
        if (event.chatId !== chatId || !isCurrent(event.instance)) return;
        // The CLI stamps its own ISO time; the log has a time column already.
        const line = event.line.replace(/^\S+Z\s+/, "");
        logDebug(
          chatId,
          "cli",
          line.length > 160 ? `${line.slice(0, 160)}…` : line,
          event.line,
        );
      }),
      onPermissionRequest((request) => {
        // Each child names its own chat id on its prompt server's command line,
        // so an ask says who raised it. The old test was "am I the pane with a
        // turn in flight", which is only ever right when one chat is live.
        //
        // Unlike the instance-filtered listeners above, this one can land in a
        // cold pane — a detached daemon under this chat id raising an ask. On
        // purpose: a tab blocked on a human should say "awaiting" before it is
        // ever shown. The first spawn wipes the card with the rest of the
        // pre-spawn items and gets it back through status.pendingPermissions.
        if (request.chatId !== chatId) return;
        logDebug(chatId, "permission", `ask · ${request.toolName}`, request);
        if (
          AUTO_ALLOWED_TOOLS.has(request.toolName) ||
          alwaysAllowRef.current.has(request.toolName)
        ) {
          void permissionRespond(request.id, "allow");
          return;
        }
        stickyRef.current = true;
        setPhase("awaiting your permission");
        appendItem({ kind: "permission", key: nextKey(), request, decided: null });
      }),
      onClaudeToolActivity((event) => {
        if (event.chatId === chatId && isCurrent(event.instance)) {
          logDebug(chatId, "probe", event.command ?? "(tool finished)", event);
          setToolActivity(event.command);
        }
      }),
      onClaudeExit((event) => {
        if (event.chatId !== chatId || !isCurrent(event.instance)) return;
        setAlive(false);
        setRunning(false);
        setPhase("exited");
        setPendingTool(null);
        setToolActivity(null);
        setTurnStartedAt(null);
        // Nothing is going to answer the panels still waiting; a card saying so
        // beats one spinning until its timeout.
        abortControl(chatId, "claude exited");
        logDebug(chatId, "exit", `code ${event.code ?? "signal"}`);
        onSystemMessageRef.current(`claude exited (code ${event.code ?? "unknown"})`);
      }),
    ];
    return () => {
      for (const subscription of subscriptions) void subscription.then((fn) => fn());
    };
  }, [chatId, handleFrame, appendItem, isCurrent]);

  /* ---------- scrolling ---------- */

  const onScroll = useCallback(() => {
    const element = logRef.current;
    if (!element) return;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    stickyRef.current = distanceFromBottom < STICKY_THRESHOLD_PX;
  }, []);

  // Also on `visible`: turns that arrived while the pane was hidden could not
  // be scrolled to, so becoming visible is the moment to re-pin.
  useLayoutEffect(() => {
    if (visible && stickyRef.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [items, visible]);

  // Coming to the front means you want to type: a new session, or a tab switch
  // back to this one, should not need a click in the composer first.
  useEffect(() => {
    if (!visible) return;
    composerRef.current?.focus();
  }, [visible]);

  /* ---------- composer autocomplete ---------- */

  /** What the caret is sitting in: a `/command`, an `@mention`, or prose. */
  const trigger: ComposerTrigger = useMemo(() => detectTrigger(draft, caret), [draft, caret]);
  /** Native commands merged with the CLI's catalog; rebuilt only on reload. */
  const menuEntries = useMemo(() => buildMenu(catalog?.commands ?? []), [catalog]);
  const [menuDismissed, setMenuDismissed] = useState(false);

  // A fresh trigger is a fresh list, so the highlight goes back to the top and
  // an earlier Escape stops suppressing the menu.
  useEffect(() => {
    setMenuCursor(0);
    setMenuDismissed(false);
  }, [trigger?.kind, trigger?.query]);

  /*
   * `@` completion runs against mangouste's own file index rather than the
   * CLI's `file_suggestions` control request: the index is already here, it
   * answers locally, and it does not spend a round trip per keystroke.
   */
  useEffect(() => {
    if (trigger?.kind !== "file") {
      setFileMatches([]);
      return;
    }
    let cancelled = false;
    const query = trigger.query;
    const timer = setTimeout(() => {
      void searchFiles(cwd, query, 20)
        .then((entries) => {
          if (!cancelled) setFileMatches(entries.map((e) => e.path));
        })
        .catch(() => {
          if (!cancelled) setFileMatches([]);
        });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trigger?.kind, trigger?.query, cwd]);

  const menuItems = useMemo<ComposerMenuItem[]>(() => {
    if (!trigger) return [];
    if (trigger.kind === "command") {
      return filterMenu(menuEntries, trigger.query).map((entry) => ({
        key: entry.name,
        insert: `/${entry.name} `,
        primary: `/${entry.name}`,
        hint: entry.argumentHint,
        secondary: entry.description,
        // Marks the ones that never reach the CLI, so it is clear which cost a
        // turn and which are answered in-app.
        badge: entry.native ? "app" : undefined,
      }));
    }
    return fileMatches.map((path) => {
      const relative = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
      return { key: path, insert: `@${relative} `, primary: relative, secondary: path };
    });
  }, [trigger, menuEntries, fileMatches, cwd]);

  const menuOpen = trigger !== null && !menuDismissed && menuItems.length > 0;

  const pickMenu = useCallback(
    (index: number) => {
      if (!trigger) return;
      const item = menuItems[index];
      if (!item) return;
      const next = applyCompletion(draft, trigger, caret, item.insert);
      setDraft(next.draft);
      setCaret(next.caret);
      // React writes the value after this handler returns, so the caret has to
      // be placed on the next frame or it lands at the end of the old text.
      requestAnimationFrame(() => {
        const element = composerRef.current;
        if (!element) return;
        element.focus();
        element.setSelectionRange(next.caret, next.caret);
      });
    },
    [trigger, menuItems, draft, caret],
  );

  /* ---------- composing ---------- */

  const send = useCallback(async () => {
    const text = draft.trim();
    // An image with no caption is still a message worth sending.
    if ((!text && attachments.length === 0) || !alive) return;

    /*
     * A command mangouste answers itself never reaches the CLI.
     *
     * These are the interactive panels a `--print` session refuses outright,
     * plus the few it answers with one line of prose where the control protocol
     * hands back the data the TUI panel is drawn from. Either way there is no
     * turn and no tokens, so none of the running/elapsed bookkeeping applies.
     */
    const parsed = attachments.length === 0 ? parseSlash(text) : null;
    const native = parsed ? toNative(parsed.name) : null;
    if (parsed && native) {
      setDraft("");
      setCaret(0);
      stickyRef.current = true;
      appendItem({ kind: "user", key: nextKey(), text });
      appendItem({ kind: "panel", key: nextKey(), command: native, args: parsed.args });
      logDebug(chatId, "send", `/${native} · answered in-app`);
      return;
    }

    setDraft("");
    setCaret(0);
    setAttachments([]);
    stickyRef.current = true;
    appendItem({
      kind: "user",
      key: nextKey(),
      text:
        attachments.length > 0
          ? `${text}${text ? "\n" : ""}[${attachments.length} image${attachments.length > 1 ? "s" : ""} attached]`
          : text,
    });
    setRunning(true);
    setPhase("sending");
    setTurnStartedAt(Date.now());
    logDebug(chatId, "send", text ? clipForSpinner(text) : "[images]");
    try {
      if (attachments.length === 0) {
        await claudeSend(chatId, text);
      } else {
        // Images must precede the text block, matching how the API reads them.
        const content = [
          ...attachments.map((image) => ({
            type: "image",
            source: { type: "base64", media_type: image.mediaType, data: image.data },
          })),
          ...(text ? [{ type: "text", text }] : []),
        ];
        await claudeSendRaw(chatId, {
          type: "user",
          message: { role: "user", content },
        });
      }
    } catch (e) {
      setRunning(false);
      setPhase("send failed");
      onSystemMessage(`send failed: ${e}`);
    }
  }, [draft, attachments, alive, chatId, appendItem]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // The popup owns these keys while it is up, so they are intercepted
      // before Enter can send a half-typed command name.
      if (menuOpen) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setMenuCursor((cursor) => Math.min(cursor + 1, menuItems.length - 1));
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setMenuCursor((cursor) => Math.max(cursor - 1, 0));
          return;
        }
        if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !event.ctrlKey)) {
          event.preventDefault();
          pickMenu(menuCursor);
          return;
        }
        if (event.key === "Escape") {
          // preventDefault matters: the window-level handler reads it to decide
          // whether Escape was already spoken for, and this one must not
          // interrupt the turn as well.
          event.preventDefault();
          setMenuDismissed(true);
          return;
        }
      }
      // VSCode chat semantics: Enter sends, Shift+Enter inserts a newline.
      if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey) {
        event.preventDefault();
        void send();
      }
    },
    [menuOpen, menuItems.length, menuCursor, pickMenu, send],
  );

  const onPaste = useCallback(async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Trust the webview when it does surface an image; fall back to the system
    // clipboard, which is the path that actually fires under WebKitGTK.
    const hasImageItem = Array.from(event.clipboardData?.items ?? []).some((item) =>
      item.type.startsWith("image/"),
    );
    const hasText = (event.clipboardData?.getData("text/plain") ?? "").length > 0;
    if (hasText && !hasImageItem) return;

    // Decided synchronously: after the first await the event has already been
    // dispatched, so a late preventDefault is a no-op — which is what pasted
    // the text of a text+image clipboard alongside the attached image.
    event.preventDefault();
    try {
      const image = await clipboardImage();
      if (!image) return;
      setAttachments((current) => [
        ...current,
        { id: `img-${sequenceRef.current++}`, ...image },
      ]);
    } catch {
      // Nothing usable on the clipboard; there was no text to paste either.
    }
  }, []);

  const interrupt = useCallback(async () => {
    try {
      await claudeInterrupt(chatId, `interrupt-${Date.now()}`);
    } catch {
      // The interrupt frame could not be written, so the process is the problem.
      await claudeKill(chatId);
    }
    setRunning(false);
  }, [chatId]);

  // The activity line advertises "esc to interrupt"; make that true.
  useEffect(() => {
    if (!running) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Panes for background tabs stay mounted (hidden); only the visible one
      // may catch Escape, or a background turn gets cut off too.
      if (!logRef.current || logRef.current.offsetParent === null) return;
      event.preventDefault();
      void interrupt();
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [running, interrupt]);

  // Push stats up whenever any of them move.
  useEffect(() => {
    onStats({ sessionId, model, contextTokens, costUsd });
  }, [onStats, sessionId, model, contextTokens, costUsd]);

  /*
   * A control request moved the live process, so the composer switch that arms
   * the next spawn has to move with it — otherwise the two disagree and the
   * strip claims a pending change that already happened.
   */
  const applyModel = useCallback(
    (value: string) => {
      modelAliasRef.current = value;
      setModelAlias(value);
      setSpawnedModelAlias(value);
      onModel(value);
    },
    [onModel],
  );

  const applyPermissionMode = useCallback((mode: string) => {
    permissionModeRef.current = mode;
    setPermissionMode(mode);
    setSpawnedPermissionMode(mode);
  }, []);

  /*
   * Composer picks go to the live process over the control channel, the same
   * one /model and /permissions use, so a switch lands on the session already
   * running instead of waiting for the next spawn. The choice is armed locally
   * either way: with no process to talk to — or with a CLI too old to answer —
   * it falls back to the pending-until-restart behaviour the strip advertises.
   */
  const pickModel = useCallback(
    (alias: string) => {
      modelAliasRef.current = alias;
      setModelAlias(alias);
      onModel(alias);
      if (!alive) return;
      void controlSetModel(chatId, alias === MODEL_DEFAULT ? null : alias)
        .then((result) => {
          const applied = result.model ?? alias;
          logDebug(chatId, "control", `set_model · ${applied}`);
          setSpawnedModelAlias(alias);
        })
        .catch((e) => {
          logDebug(chatId, "control", `set_model failed: ${String(e)}`);
        });
    },
    [alive, chatId, onModel],
  );

  const pickPermissionMode = useCallback(
    (mode: string) => {
      permissionModeRef.current = mode;
      setPermissionMode(mode);
      if (!alive) return;
      void controlSetPermissionMode(chatId, mode)
        .then((result) => {
          const applied = result.mode ?? mode;
          logDebug(chatId, "control", `set_permission_mode · ${applied}`);
          permissionModeRef.current = applied;
          setPermissionMode(applied);
          setSpawnedPermissionMode(applied);
        })
        .catch((e) => {
          logDebug(chatId, "control", `set_permission_mode failed: ${String(e)}`);
        });
    },
    [alive, chatId],
  );

  const panelContext = useMemo<PanelContext>(
    () => ({
      chatId,
      cwd,
      sessionId,
      catalog,
      permissionMode: spawnedPermissionMode,
      onModelApplied: applyModel,
      onPermissionModeApplied: applyPermissionMode,
    }),
    [chatId, cwd, sessionId, catalog, spawnedPermissionMode, applyModel, applyPermissionMode],
  );

  const timeline = useMemo(() => toTimeline(items, toolResults), [items, toolResults]);

  const statusLabel = useMemo(() => {
    // "stopped" claims an exit; a cold pane simply has not started yet.
    if (!alive) return warmed ? "stopped" : "not started";
    return running ? "working…" : "ready";
  }, [alive, running, warmed]);

  /**
   * The whole transcript as text, for "Copy Conversation".
   *
   * Rendered from the timeline rather than from the raw frames, so what lands on
   * the clipboard is what is on screen — tool payloads included, permission
   * cards not.
   */
  const transcriptText = useCallback(
    () =>
      timeline
        .map((entry) => {
          const text = entryText(entry);
          return text === null ? null : `[${entry.kind}] ${text}`;
        })
        .filter((line): line is string => line !== null)
        .join("\n\n"),
    [timeline],
  );

  /** Chat-wide entries, shared by the log's rows and its background. */
  const logMenu = useCallback(
    (): MenuEntry[] => [
      {
        label: "Copy Conversation",
        disabled: timeline.length === 0,
        run: () => void copyText(transcriptText()),
      },
      {
        label: "Scroll to Latest",
        run: () => {
          const log = logRef.current;
          if (log) log.scrollTop = log.scrollHeight;
        },
      },
      "separator",
      running
        ? { label: "Interrupt Turn", accelerator: CHORD.dismiss, danger: true, run: () => void interrupt() }
        : { label: "Restart Session", run: () => void restart() },
    ],
    [timeline.length, transcriptText, running, interrupt, restart],
  );

  /** Right-click in the composer: what to do with the draft, then the field. */
  const composerMenu = useCallback(
    (): MenuEntry[] => [
      {
        label: "Send",
        accelerator: CHORD.send,
        disabled: !alive || (!draft.trim() && attachments.length === 0),
        run: () => void send(),
      },
      running && {
        label: "Interrupt Turn",
        accelerator: CHORD.dismiss,
        danger: true,
        run: () => void interrupt(),
      },
      draft !== "" && { label: "Clear Draft", run: () => setDraft("") },
      attachments.length > 0 && {
        label: `Remove ${attachments.length} Attachment${attachments.length === 1 ? "" : "s"}`,
        run: () => setAttachments([]),
      },
      "separator",
      "editing",
      "separator",
      { label: "Restart Session", run: () => void restart() },
    ],
    [alive, draft, attachments.length, running, send, interrupt, restart],
  );

  return (
    <div className="chat">
      <div
        className="chat-log selectable"
        ref={logRef}
        onScroll={onScroll}
        onContextMenu={(event) =>
          menu.openContextMenu(event, ["editing", "separator", ...logMenu()])
        }
      >
        <Timeline
          entries={timeline}
          toolResults={toolResults}
          onOpenFile={onOpenFile}
          onDecide={decide}
          panelContext={panelContext}
          logMenu={logMenu}
        />

        {running && !awaitingPermission && (
          <Activity
            detail={
              pendingTool
                ? [pendingTool.name, pendingTool.detail].filter(Boolean).join(" · ")
                : null
            }
            startedAt={pendingTool?.startedAt ?? turnStartedAt}
            sub={toolActivity}
          />
        )}
      </div>

      <div
        className="chat-composer"
        onContextMenu={(event) => menu.openContextMenu(event, composerMenu())}
      >
        {attachments.length > 0 && (
          <div className="attachment-strip">
            {attachments.map((image) => (
              <span className="attachment-chip" key={image.id}>
                <img
                  alt=""
                  src={`data:${image.mediaType};base64,${image.data}`}
                  className="attachment-thumb"
                />
                <span>
                  {image.width}×{image.height}
                </span>
                <button
                  onClick={() =>
                    setAttachments((current) => current.filter((a) => a.id !== image.id))
                  }
                  title="Remove"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-input">
          <textarea
            ref={composerRef}
            value={draft}
            onPaste={(event) => void onPaste(event)}
            placeholder={
              alive
                ? "Message Claude…  (/ for commands, @ for files)"
                : warmed
                  ? "Not running"
                  : "Not started"
            }
            onChange={(event) => {
              setDraft(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
            }}
            // Fires on every caret move, arrow keys included, which is what
            // decides whether an `@` mention is under the cursor.
            onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
            onFocus={() => setMenuDismissed(false)}
            onBlur={() => setMenuDismissed(true)}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
          {menuOpen && (
            <ComposerMenu
              items={menuItems}
              cursor={menuCursor}
              onPick={pickMenu}
              onHover={setMenuCursor}
            />
          )}
        </div>
        <div className="composer-bar">
          <span
            className="status-dot"
            data-status={running ? "active" : alive ? "finished" : "idle"}
          />
          <span>{running ? "working" : statusLabel}</span>
          {sessionId && <span title={sessionId}>· {sessionId.slice(0, 8)}</span>}
          {costUsd !== null && <span>· ${costUsd.toFixed(4)}</span>}
          <span className="spacer" />
          <div
            className="mode-switch"
            data-pending={modelAlias !== spawnedModelAlias}
            title={
              modelAlias !== spawnedModelAlias
                ? `Pending — running as "${spawnedModelAlias}". Restart to apply.`
                : alive
                  ? "Model (applies to the running session)"
                  : "Model (applies on next start)"
            }
          >
            {MODELS.map((alias) => (
              <button
                key={alias}
                className="toggle-button"
                data-active={alias === modelAlias}
                onClick={() => pickModel(alias)}
              >
                {alias}
              </button>
            ))}
          </div>
          <div
            className="mode-switch"
            data-pending={permissionMode !== spawnedPermissionMode}
            title={
              permissionMode !== spawnedPermissionMode
                ? `Pending — running as "${spawnedPermissionMode}". Restart to apply.`
                : alive
                  ? "Permission mode (applies to the running session)"
                  : "Permission mode (applies on next start)"
            }
          >
            {PERMISSION_MODES.map((mode) => (
              <button
                key={mode}
                className="toggle-button"
                data-active={mode === permissionMode}
                onClick={() => pickPermissionMode(mode)}
              >
                {MODE_LABELS[mode]}
              </button>
            ))}
          </div>
          <button className="toggle-button" onClick={() => void restart()}>
            restart
          </button>
          {running ? (
            <button className="danger-button" onClick={() => void interrupt()}>
              stop
            </button>
          ) : (
            <button
              className="primary-button"
              disabled={!alive || (!draft.trim() && attachments.length === 0)}
              onClick={() => void send()}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
