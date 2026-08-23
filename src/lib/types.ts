/** Mirrors the `#[derive(Serialize)]` structs in `src-tauri/src`. */

/// Mirrors `classify` in `src-tauri/src/sessions.rs`.
///
/// active        — a turn is in flight (or agents/queued prompts still working)
/// awaiting      — stopped to ask you something; blocked until you reply
/// pendingReview — ended cleanly, but you have not looked at it since
/// finished      — ended cleanly and you have seen it
/// interrupted   — went quiet mid-turn: ESC, dead window, or an API error
/// idle          — nothing for over a day
///
/// `pendingReview` never comes off the wire: Rust reports `finished` and the
/// seen-store overlay in `sessionStore.ts` rewrites it, exactly as the extension
/// does. Everything else is decided in `classify`.
export type SessionStatus =
  | "active"
  | "awaiting"
  | "pendingReview"
  | "finished"
  | "interrupted"
  | "idle";

/**
 * One subagent whose sidechain log is being written right now.
 *
 * Read from the log files, not from the parent transcript: a mid-flight fan-out
 * is precisely when the parent has written nothing, and Workflow-tool agents
 * have no per-agent `tool_use` there at all.
 */
export interface RunningAgent {
  id: string;
  agentType: string;
  description: string;
  filePath: string;
  mtimeMs: number;
}

/** A Workflow-tool run with agents writing right now. */
export interface RunningWorkflow {
  runId: string;
  name: string | null;
  status: string | null;
  phase: string | null;
  agentCount: number | null;
  newestMtimeMs: number;
  agents: RunningAgent[];
  jsonPath: string | null;
}

export interface SessionMeta {
  id: string;
  file: string;
  projectDir: string;
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  lastPrompt: string | null;
  model: string | null;
  version: string | null;
  modifiedMs: number;
  /**
   * Conversational watermark, which is what the read/unread overlay keys on —
   * opening a session rewrites its log without adding conversation.
   */
  lastActivityMs: number;
  sizeBytes: number;
  status: SessionStatus;
  messageCount: number;
  /** False when the transcript was larger than the sampled tail, so the count is a floor. */
  messageCountExact: boolean;
  /** Agent-tool subagents writing within the active window, newest first. */
  runningAgents: RunningAgent[];
  /** Workflow-tool runs with agents writing within the active window. */
  runningWorkflows: RunningWorkflow[];
}

export interface ProjectGroup {
  dirName: string;
  cwd: string;
  label: string;
  sessions: SessionMeta[];
}

/**
 * One transcript that matched a content search, with the evidence for it.
 *
 * Mirrors `SessionHit` in `src-tauri/src/sessions.rs`. The sidebar joins these
 * to scanned sessions by `id`, so a hit in a transcript the scan skipped (the
 * title-generator scratch group) simply does not surface.
 */
export interface SessionHit {
  id: string;
  file: string;
  dirName: string;
  /** Conversational records that contained at least one term. */
  matchCount: number;
  /** Matching text, trimmed to a window around the first term. */
  snippet: string;
  /** `user` | `assistant` — who said the snippet. */
  role: string;
  snippets: string[];
}

export interface DirEntryInfo {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedMs: number;
}

/** A file's text plus the mtime it was read at, from `read_text_file_meta`. */
export interface FileText {
  content: string;
  modifiedMs: number;
}

export interface RepoInfo {
  name: string;
  path: string;
  isGit: boolean;
}

export interface Commit {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  timestamp: number;
  parents: string[];
  refs: string[];
  subject: string;
}

export interface FileStatus {
  code: string;
  path: string;
  originalPath: string | null;
  staged: boolean;
  unstaged: boolean;
}

export interface RepoStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: FileStatus[];
}

export interface ChatStatus {
  chatId: string;
  /** Monotonic spawn id, used to discard events from a superseded process. */
  instance: number;
  cwd: string;
  sessionId: string | null;
  pid: number | null;
  alive: boolean;
  /**
   * A turn is in flight.
   *
   * Tracked in Rust, so a pane that attaches to a chat already mid-turn knows to
   * show "working…" for a turn it never watched start.
   */
  running: boolean;
  /** True when `claudeStart` found a live process and attached to it. */
  attached: boolean;
  /** Mode the live process was actually spawned with. */
  permissionMode: string | null;
  /** Tool prompts raised while nothing was attached to this chat. */
  pendingPermissions: PermissionRequest[];
}

export interface StartOptions {
  chatId: string;
  cwd: string;
  resume?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  extraArgs?: string[] | null;
  /** Spawn with `--debug-file` and tail it into `claude://debug` events. */
  debug?: boolean;
}

export interface TerminalInfo {
  id: string;
  /** Monotonic spawn id, used to discard events from a superseded terminal. */
  instance: number;
  cwd: string;
  alive: boolean;
}

/** A single line from a `--output-format stream-json` process. */
export interface ClaudeFrame {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: ContentBlock[] | string;
    stop_reason?: string | null;
    usage?: Record<string, number>;
  };
  event?: Record<string, unknown>;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  is_error?: boolean;
  [key: string]: unknown;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

/** Anything the CLI emits that this build does not model yet. */
export interface UnknownBlock {
  type: string;
  [key: string]: unknown;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | UnknownBlock;

export interface UsageWindow {
  percent: number;
  resetsAt: string | null;
}

export interface ModelWindow {
  model: string;
  percent: number;
  resetsAt: string | null;
}

export interface ClaudeUsage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  sevenDaySonnet: UsageWindow | null;
  sevenDayOpus: UsageWindow | null;
  modelWindows: ModelWindow[];
  extraPercent: number | null;
  fetchedAtMs: number;
}

export interface ClipboardImage {
  mediaType: string;
  /** Base64 PNG, already downscaled to a sane longest edge. */
  data: string;
  width: number;
  height: number;
}

export interface PermissionRequest {
  id: string;
  /**
   * Chat that raised the ask.
   *
   * Null only for a request from a child spawned before chat-scoped prompt
   * configs existed; panes ignore those rather than guessing.
   */
  chatId: string | null;
  toolName: string;
  toolUseId: string | null;
  input: unknown;
}

/* ---------- dashboard statistics ---------- */

/**
 * Token counts and their estimated cost, at every roll-up level.
 *
 * Mirrors `TokenTotals` in `src-tauri/src/stats.rs`. `costUsd` is what these
 * turns would bill at first-party API list prices — a subscription pays a flat
 * fee instead, so read it as a measure of work done, not of money owed.
 */
export interface TokenTotals {
  /** Uncached input, billed at the full input rate. */
  input: number;
  output: number;
  /** Tokens written to the cache, both TTLs. */
  cacheWrite: number;
  /** The 1h-TTL share of `cacheWrite`, which bills at 2x rather than 1.25x. */
  cacheWrite1h: number;
  cacheRead: number;
  /** Thinking tokens, already counted inside `output`. */
  thinking: number;
  total: number;
  /** Deduplicated assistant responses — one per API call. */
  turns: number;
  costUsd: number;
  /** The same turns priced with every cached token billed as plain input. */
  noCacheCostUsd: number;
}

export interface ModelStat {
  model: string;
  tokens: TokenTotals;
}

export interface NameCount {
  name: string;
  count: number;
}

export interface McpStat {
  server: string;
  calls: number;
  /** Still configured in `~/.claude.json`, globally or for some project. */
  configured: boolean;
  tools: NameCount[];
}

export interface DayStat {
  /** `YYYY-MM-DD`, in the timezone the transcript recorded (UTC). */
  day: string;
  tokens: TokenTotals;
}

export interface SessionStats {
  id: string;
  file: string;
  projectDir: string;
  cwd: string | null;
  /** Dominant model by output tokens. */
  model: string | null;
  tokens: TokenTotals;
  /** Subagent and workflow transcripts spawned under this session. */
  agentFiles: number;
  /** The share of `tokens` that came from those subagent transcripts. */
  agentTokens: TokenTotals;
  toolCalls: number;
  mcpCalls: number;
  /** Approximate: counts `user` records that are not tool-result echoes. */
  userMessages: number;
  firstMs: number;
  lastMs: number;
  sizeBytes: number;
}

export interface ProjectStats {
  dirName: string;
  cwd: string;
  label: string;
  sessionCount: number;
  agentFiles: number;
  tokens: TokenTotals;
  models: ModelStat[];
  tools: NameCount[];
  mcp: McpStat[];
  firstMs: number;
  lastMs: number;
  sizeBytes: number;
}

export interface StatsSummary {
  tokens: TokenTotals;
  models: ModelStat[];
  tools: NameCount[];
  mcp: McpStat[];
  days: DayStat[];
  projects: ProjectStats[];
  sessions: SessionStats[];
  sessionCount: number;
  agentFileCount: number;
  sizeBytes: number;
  /** Servers configured in `~/.claude.json` that never appear in a tool call. */
  unusedMcpServers: string[];
  /** Files whose appended bytes were read on this call — 0 on a warm rescan. */
  filesRead: number;
  bytesRead: number;
  scanMs: number;
  generatedAtMs: number;
}
