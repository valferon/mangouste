/** Mirrors the `#[derive(Serialize)]` structs in `src-tauri/src`. */

/// Mirrors `classify` in `src-tauri/src/sessions.rs`.
///
/// active        — a turn is in flight (or agents/queued prompts still working)
/// awaiting      — stopped to ask you something; blocked until you reply
/// pendingReview — ended cleanly, but you have not looked at it since
/// finished      — ended cleanly and you have seen it
/// interrupted   — went quiet mid-turn: ESC, dead window, or an API error
/// idle          — nothing for over a day, and none of the above
///
/// `awaiting` and `interrupted` outrank `idle`: an unanswered question and a
/// cut-off turn do not expire on a clock, and `idle` rows are hidden by default.
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

/**
 * What the Find & Replace view asked for. Mirrors `SearchOptions` in
 * `src-tauri/src/search.rs`, where every field also defaults.
 */
export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Read the query as a regex — and `$1` in the replacement as a capture. */
  regex: boolean;
  /** Comma-separated gitignore-style globs. Non-empty means "only these". */
  include: string;
  exclude: string;
  respectGitignore?: boolean;
  showHidden?: boolean;
  maxMatches?: number;
}

/**
 * One match, with its line pre-split around it.
 *
 * Rust does the splitting because the offsets it matched at are UTF-8 and a JS
 * string is UTF-16: `before`/`matched`/`after` are the only form of a highlight
 * that cannot be off by a byte. `start`/`end` are opaque here — they are the
 * match's identity, handed straight back to `replaceMatches`.
 */
export interface SearchMatch {
  /** 1-based, as the editor's gutter counts. */
  line: number;
  /** 1-based character column, for placing the caret when the file opens. */
  column: number;
  start: number;
  end: number;
  before: string;
  matched: string;
  after: string;
}

export interface FileHit {
  path: string;
  /** `path` as written from inside the searched root — what the pane shows. */
  relative: string;
  /** The mtime the matches were read at, handed back so a replace can be refused. */
  modifiedMs: number;
  matches: SearchMatch[];
  /** This file had more matches than the per-file cap. */
  truncated: boolean;
}

export interface SearchOutcome {
  files: FileHit[];
  totalMatches: number;
  /** The sweep hit its cap, so the results are a prefix of the truth. */
  truncated: boolean;
}

/** Per-file outcome of a replace. A refused file does not stop the others. */
export interface ReplaceResult {
  path: string;
  replaced: number;
  error: string | null;
}

export interface ReplaceOutcome {
  files: ReplaceResult[];
  replaced: number;
  failed: number;
}

/** What a formatter made of a buffer, and which one it was. */
export interface Formatted {
  text: string;
  /** `prettier`, `rustfmt` — named in the editor's status line. */
  formatter: string;
  /** False when the buffer was already formatted, which is worth saying. */
  changed: boolean;
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

/** One changed file inside a commit, as `gitCommitDetail` reports it. */
export interface CommitFile {
  /** Raw git status letter: `M`, `A`, `D`, `R096`, … */
  status: string;
  /** Post-image path — the one to ask `gitShowFile` for. */
  path: string;
  /** Pre-image path, present only for a rename or a copy. */
  originalPath: string | null;
  /** Null for a binary file, which git counts as `-` and not as zero. */
  additions: number | null;
  deletions: number | null;
}

/** Everything the history pane shows on the right for one selected commit. */
export interface CommitDetail {
  commit: Commit;
  /** The message below the subject line, trailing blank lines trimmed. */
  body: string;
  committer: string;
  committerEmail: string;
  commitTimestamp: number;
  files: CommitFile[];
}

/**
 * What a history query is narrowed to. Blank fields are not filters: the pane
 * sends whatever is in its boxes, and the Rust side treats empty as absent.
 */
export interface LogFilter {
  author?: string;
  text?: string;
  path?: string;
  branch?: string;
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

export interface BlameCommit {
  sha: string;
  /** First 8 characters of `sha`, which is what the column shows. */
  shortSha: string;
  author: string;
  authorEmail: string;
  /** Author time, in seconds — git's own unit for it. */
  timestamp: number;
  summary: string;
}

/**
 * One file's blame: a commit table plus an index into it per line.
 *
 * Indices rather than a sha per line, for the reason the Rust side gives — a
 * long file blames to a handful of commits, and a 40-character sha on every
 * line would dwarf the file itself.
 */
export interface Blame {
  commits: BlameCommit[];
  /** One index per line of the file on disk, in order. */
  lines: number[];
}

export interface BranchList {
  current: string | null;
  local: string[];
  /** Remote-tracking branches, remote prefix kept (`origin/main`). */
  remote: string[];
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
  /**
   * The API's opaque attestation of this block, and the only stable name it has.
   *
   * Load-bearing here because `thinking` is *not* persisted: every block written
   * to a transcript carries its signature and an empty string, so the text a
   * resumed session shows can only come from what this app kept while the turn
   * was live. The signature is what joins the two.
   */
  signature?: string;
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

/* ---------- CLI control protocol ---------- */

/*
 * Shapes returned by `control_request` frames on the chat's stdin/stdout.
 *
 * These are the CLI's own panel data — what `/model`, `/mcp` and `/context`
 * render in the interactive TUI. A `--print` session refuses to run those
 * commands (they are Ink components), but it answers every request below, so
 * the panels can be rebuilt here. See `src/lib/control.ts`.
 */

/** One entry of the CLI's slash-command catalog, from `initialize`. */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
}

export interface ModelOption {
  value: string;
  resolvedModel: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

export interface AgentSummary {
  name: string;
  description: string;
}

export interface AccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  apiProvider?: string;
}

/**
 * Everything the CLI reports about a freshly connected session.
 *
 * `commands` is already filtered to what this environment can actually run:
 * the interactive-only commands (`/help`, `/status`, `/permissions`) are absent,
 * which is exactly the set mangouste supplies itself.
 */
export interface InitializeResult {
  commands: SlashCommand[];
  models: ModelOption[];
  agents: AgentSummary[];
  account: AccountInfo | null;
  output_style: string | null;
  available_output_styles: string[];
  current_permission_mode: string | null;
  session_state: string | null;
  pid: number | null;
}

export interface McpServerStatus {
  name: string;
  /** `connected` | `pending` | `needs-auth` | `failed` | `disabled`. */
  status: string;
  scope?: string;
  config?: { type?: string; url?: string; command?: string };
}

export interface McpStatusResult {
  mcpServers: McpServerStatus[];
}

export interface ContextCategory {
  name: string;
  tokens: number;
  /** Deferred tool schemas are counted but not yet loaded into the prompt. */
  isDeferred?: boolean;
}

export interface ContextUsageResult {
  categories: ContextCategory[];
  totalTokens: number;
  maxTokens: number;
  percentage: number;
}

/** One plan rate-limit window. Keys with a different shape are skipped by the panel. */
export interface RateLimitWindow {
  utilization: number;
  resets_at: string | null;
}

export interface ControlUsageResult {
  session: {
    total_cost_usd: number;
    total_duration_ms: number;
    total_lines_added: number;
    total_lines_removed: number;
  };
  subscription_type: string | null;
  rate_limits_available: boolean;
  /** Window name to utilization. Null entries mean the plan has no such window. */
  rate_limits: Record<string, unknown> | null;
}

export interface ControlSettingsResult {
  effective: Record<string, unknown>;
  sources?: Record<string, unknown>;
}

export interface BinaryVersionResult {
  version: string;
  buildTime?: string;
}

export interface ReloadSkillsResult {
  skills: SlashCommand[];
}

export interface ReloadPluginsResult {
  commands: SlashCommand[];
  agents?: AgentSummary[];
}

/** One published GitHub release, as `update::fetch_release` reduces it. */
export interface Release {
  /** The tag with its `v` stripped, so it compares against the bundle version. */
  version: string;
  /** The tag as GitHub has it. */
  tag: string;
  name: string;
  /** Release body, verbatim markdown. Empty when the notes are blank. */
  notes: string;
  /** The release page, which is where the downloads are. */
  url: string;
  publishedAt: string | null;
  prerelease: boolean;
}
