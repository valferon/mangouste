//! Corpus-wide token, cost, tool and MCP statistics over every transcript.
//!
//! `sessions.rs` samples the head and tail of each file because it only needs
//! the volatile facts. Totals cannot be sampled: a dashboard that adds up 160KB
//! of a 11MB session is not a total, it is a rumour. So this module reads whole
//! files — once — and then resumes from a byte offset, which works because
//! transcripts are append-only. A rescan after a streaming turn reads only the
//! bytes that turn appended.
//!
//! Only lines that can carry usage are JSON-parsed; the rest are rejected by a
//! byte-substring test. Over the local 277MB corpus that is the difference
//! between parsing 25k records and parsing 1.1M.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

/* ---------- pricing ---------- */

/// First-party API list price, in dollars per million tokens.
///
/// Every cost this module reports is "what these turns would have billed at API
/// rates" — a Max subscription pays a flat fee instead, so the number is a
/// measure of work done, not of money owed. The frontend labels it as such.
#[derive(Clone, Copy)]
struct Price {
    input: f64,
    output: f64,
}

/// Cache reads bill at a tenth of the input rate; writes carry a premium that
/// depends on the TTL the request asked for (1.25x for 5m, 2x for 1h).
const CACHE_READ_MULTIPLIER: f64 = 0.1;
const CACHE_WRITE_5M_MULTIPLIER: f64 = 1.25;
const CACHE_WRITE_1H_MULTIPLIER: f64 = 2.0;

/// Marker appended to the model key when the turn ran in fast mode, which is
/// the same model at premium rates. Kept in the key rather than in a parallel
/// field so the per-model breakdown shows the two prices apart.
const FAST_SUFFIX: &str = " (fast)";

/// Price for a model id as Claude Code writes it into the transcript.
///
/// Ordered most-specific first: `claude-opus-4-8` is Opus-tier at $5/$25 while
/// the original `claude-opus-4-1` billed at $15/$75, so a bare `claude-opus`
/// prefix cannot be the only rule. Unknown ids price at zero rather than
/// guessing — a wrong number is worse here than a visible gap.
fn price_for(model: &str) -> Price {
    let fast = model.ends_with(FAST_SUFFIX);
    let base = model.strip_suffix(FAST_SUFFIX).unwrap_or(model);
    let price = |input: f64, output: f64| Price { input, output };

    // Fast mode is Opus-5/4.8 only, and prices at the Fable tier.
    if fast && base.starts_with("claude-opus") {
        return price(10.0, 50.0);
    }
    if base.starts_with("claude-fable") || base.starts_with("claude-mythos") {
        return price(10.0, 50.0);
    }
    if base.starts_with("claude-opus-5")
        || base.starts_with("claude-opus-4-5")
        || base.starts_with("claude-opus-4-6")
        || base.starts_with("claude-opus-4-7")
        || base.starts_with("claude-opus-4-8")
    {
        return price(5.0, 25.0);
    }
    // Opus 4 / 4.1 and the Claude 3 Opus generation.
    if base.starts_with("claude-opus") || base.contains("3-opus") {
        return price(15.0, 75.0);
    }
    if base.starts_with("claude-sonnet") || base.contains("sonnet") {
        return price(3.0, 15.0);
    }
    if base.starts_with("claude-haiku-4") || base.contains("haiku-4") {
        return price(1.0, 5.0);
    }
    if base.contains("3-5-haiku") {
        return price(0.8, 4.0);
    }
    if base.contains("haiku") {
        return price(0.25, 1.25);
    }
    price(0.0, 0.0)
}

/* ---------- accumulators ---------- */

/// Raw token counts for one model. Costing happens at serialisation time, so a
/// price change never requires a rescan.
#[derive(Clone, Copy, Default)]
struct Tokens {
    input: u64,
    output: u64,
    cache_write_5m: u64,
    cache_write_1h: u64,
    cache_read: u64,
    thinking: u64,
    /// Deduplicated assistant responses — one per API call, not one per record.
    turns: u64,
}

impl Tokens {
    fn add(&mut self, other: &Tokens) {
        self.input += other.input;
        self.output += other.output;
        self.cache_write_5m += other.cache_write_5m;
        self.cache_write_1h += other.cache_write_1h;
        self.cache_read += other.cache_read;
        self.thinking += other.thinking;
        self.turns += other.turns;
    }
}

/// Token counts split by model, which is the smallest unit that can be priced.
///
/// Every roll-up level (session, repo, day, global) is one of these, so
/// aggregation is a map merge and costing is the same code everywhere.
#[derive(Clone, Default)]
struct ByModel(BTreeMap<String, Tokens>);

impl ByModel {
    fn add(&mut self, model: &str, tokens: &Tokens) {
        self.0.entry(model.to_string()).or_default().add(tokens);
    }

    fn merge(&mut self, other: &ByModel) {
        for (model, tokens) in &other.0 {
            self.0.entry(model.clone()).or_default().add(tokens);
        }
    }

    fn totals(&self) -> TokenTotals {
        let mut out = TokenTotals::default();
        for (model, tokens) in &self.0 {
            let price = price_for(model);
            out.input += tokens.input;
            out.output += tokens.output;
            out.cache_write += tokens.cache_write_5m + tokens.cache_write_1h;
            out.cache_write_1h += tokens.cache_write_1h;
            out.cache_read += tokens.cache_read;
            out.thinking += tokens.thinking;
            out.turns += tokens.turns;
            out.cost_usd += cost_of(tokens, price);
            out.no_cache_cost_usd += no_cache_cost_of(tokens, price);
        }
        out.total = out.input + out.output + out.cache_write + out.cache_read;
        out
    }

    /// Per-model rows, heaviest spend first — the order the dashboard reads in.
    fn breakdown(&self) -> Vec<ModelStat> {
        let mut rows: Vec<ModelStat> = self
            .0
            .iter()
            .map(|(model, tokens)| {
                let mut single = ByModel::default();
                single.add(model, tokens);
                ModelStat {
                    model: model.clone(),
                    tokens: single.totals(),
                }
            })
            .collect();
        rows.sort_by(|a, b| {
            b.tokens
                .cost_usd
                .partial_cmp(&a.tokens.cost_usd)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        rows
    }
}

fn cost_of(tokens: &Tokens, price: Price) -> f64 {
    let per_input = price.input / 1_000_000.0;
    let per_output = price.output / 1_000_000.0;
    tokens.input as f64 * per_input
        + tokens.cache_read as f64 * per_input * CACHE_READ_MULTIPLIER
        + tokens.cache_write_5m as f64 * per_input * CACHE_WRITE_5M_MULTIPLIER
        + tokens.cache_write_1h as f64 * per_input * CACHE_WRITE_1H_MULTIPLIER
        + tokens.output as f64 * per_output
}

/// What the same turns would have cost with prompt caching switched off: every
/// cached token billed as plain input. The difference is what caching saved.
fn no_cache_cost_of(tokens: &Tokens, price: Price) -> f64 {
    let per_input = price.input / 1_000_000.0;
    let uncached = tokens.input + tokens.cache_read + tokens.cache_write_5m + tokens.cache_write_1h;
    uncached as f64 * per_input + tokens.output as f64 * (price.output / 1_000_000.0)
}

/* ---------- wire types ---------- */

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    /// Uncached input, billed at the full input rate.
    pub input: u64,
    pub output: u64,
    /// Tokens written to the cache, both TTLs.
    pub cache_write: u64,
    /// The 1h-TTL share of `cache_write`, which bills at 2x rather than 1.25x.
    pub cache_write_1h: u64,
    pub cache_read: u64,
    /// Thinking tokens, already counted inside `output`.
    pub thinking: u64,
    pub total: u64,
    /// Deduplicated assistant responses.
    pub turns: u64,
    /// Estimated spend at first-party API list prices.
    pub cost_usd: f64,
    /// The same turns priced with every cached token billed as plain input.
    pub no_cache_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStat {
    pub model: String,
    pub tokens: TokenTotals,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NameCount {
    pub name: String,
    pub count: u64,
}

/// One MCP server, with the tools that were actually called on it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStat {
    pub server: String,
    pub calls: u64,
    /// Still configured in `~/.claude.json`, globally or for some project.
    pub configured: bool,
    pub tools: Vec<NameCount>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayStat {
    /// `YYYY-MM-DD`, in the timezone the transcript recorded (UTC).
    pub day: String,
    pub tokens: TokenTotals,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub id: String,
    pub file: String,
    pub project_dir: String,
    pub cwd: Option<String>,
    /// Dominant model by output tokens — what the session mostly ran on.
    pub model: Option<String>,
    pub tokens: TokenTotals,
    /// Subagent and workflow transcripts spawned under this session.
    pub agent_files: u64,
    /// The share of `tokens` that came from those subagent transcripts.
    pub agent_tokens: TokenTotals,
    pub tool_calls: u64,
    pub mcp_calls: u64,
    /// Approximate: counts `user` records that are not tool-result echoes.
    pub user_messages: u64,
    pub first_ms: u64,
    pub last_ms: u64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStats {
    pub dir_name: String,
    pub cwd: String,
    pub label: String,
    pub session_count: u64,
    pub agent_files: u64,
    pub tokens: TokenTotals,
    pub models: Vec<ModelStat>,
    pub tools: Vec<NameCount>,
    pub mcp: Vec<McpStat>,
    pub first_ms: u64,
    pub last_ms: u64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSummary {
    pub tokens: TokenTotals,
    pub models: Vec<ModelStat>,
    pub tools: Vec<NameCount>,
    pub mcp: Vec<McpStat>,
    pub days: Vec<DayStat>,
    pub projects: Vec<ProjectStats>,
    pub sessions: Vec<SessionStats>,
    pub session_count: u64,
    pub agent_file_count: u64,
    pub size_bytes: u64,
    /// Servers configured in `~/.claude.json` that never appear in a tool call.
    pub unused_mcp_servers: Vec<String>,
    /// Files whose appended bytes were read on this call — 0 on a warm rescan.
    pub files_read: u64,
    pub bytes_read: u64,
    pub scan_ms: u64,
    pub generated_at_ms: u64,
}

/* ---------- per-file scan ---------- */

/// Everything one transcript contributes, accumulated across incremental reads.
#[derive(Clone, Default)]
struct FileStats {
    models: ByModel,
    /// Same tokens, bucketed by calendar day for the activity chart.
    days: BTreeMap<String, ByModel>,
    tools: BTreeMap<String, u64>,
    user_messages: u64,
    first_ms: u64,
    last_ms: u64,
    cwd: Option<String>,
}

impl FileStats {
    fn note_time(&mut self, ms: u64) {
        if ms == 0 {
            return;
        }
        if self.first_ms == 0 || ms < self.first_ms {
            self.first_ms = ms;
        }
        if ms > self.last_ms {
            self.last_ms = ms;
        }
    }
}

/// One transcript's resume point.
///
/// `seen` is the reason usage is not double-counted: Claude Code splits a single
/// API response across one record per content block, and every one of those
/// records repeats the same `usage` object verbatim. Adding them up inflates
/// spend by the number of blocks per turn — a bit over 2x on this corpus.
struct FileScan {
    /// Bytes already consumed as complete lines.
    offset: u64,
    seen: HashSet<Box<str>>,
    stats: FileStats,
}

impl Default for FileScan {
    fn default() -> Self {
        Self {
            offset: 0,
            seen: HashSet::new(),
            stats: FileStats::default(),
        }
    }
}

/// Incremental scan state for the whole corpus, one entry per transcript.
#[derive(Default)]
pub struct StatsCache {
    files: Mutex<HashMap<PathBuf, FileScan>>,
    /// Held for the length of one `summarize` walk, so two of them queue instead
    /// of overlapping. `files` alone cannot do that job any more: it is taken
    /// per file, and between a file's checkout and its return the map has no
    /// entry for it at all — a concurrent walk would read `unwrap_or_default()`,
    /// resume that transcript from byte 0 and re-read the whole corpus. Waiting
    /// here costs the second caller nothing: it finds every offset advanced.
    ///
    /// Lock order is guard then `files`, never the reverse, and nothing else
    /// takes the guard, so the two cannot deadlock.
    scan_guard: Mutex<()>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Days from the civil epoch, Howard Hinnant's algorithm. Beats pulling in a
/// date crate for the one thing needed here: an ISO timestamp to epoch millis.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `2026-08-22T20:14:59.987Z` to epoch millis. Returns 0 on anything else.
pub(crate) fn parse_iso_ms(text: &str) -> u64 {
    let bytes = text.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return 0;
    }
    let num = |from: usize, to: usize| -> Option<i64> { text.get(from..to)?.parse().ok() };
    let (Some(year), Some(month), Some(day)) = (num(0, 4), num(5, 7), num(8, 10)) else {
        return 0;
    };
    let (Some(hour), Some(minute), Some(second)) = (num(11, 13), num(14, 16), num(17, 19)) else {
        return 0;
    };
    let millis = text
        .get(20..23)
        .and_then(|fraction| fraction.parse::<i64>().ok())
        .unwrap_or(0);
    let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second;
    (seconds * 1_000 + millis).max(0) as u64
}

fn as_u64(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

/// Fold one transcript line into the file's accumulator.
///
/// Takes `&str` rather than `&[u8]` deliberately: `str::contains` skips ahead on
/// a mismatch, where a naive byte-window scan would compare every offset — over
/// a 277MB corpus that is the difference between one pass and several seconds.
fn ingest_line(line: &str, scan: &mut FileScan) {
    if line.len() < 8 {
        return;
    }
    // The only records that carry spend are assistant responses, and they are a
    // ~2% minority of lines. Everything else is rejected without a parse.
    if !line.contains(r#""usage""#) {
        // Human turns, counted by substring for the same reason: parsing every
        // user record means parsing every tool result, which is most of the
        // corpus by weight. Tool-result echoes are `type: "user"` too, so they
        // are excluded by their block type.
        if line.contains(r#""type":"user""#) && !line.contains("tool_result") {
            scan.stats.user_messages += 1;
        }
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let Some(message) = value.get("message") else {
        return;
    };
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return;
    }

    if scan.stats.cwd.is_none() {
        if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
            scan.stats.cwd = Some(cwd.to_string());
        }
    }

    let timestamp = value.get("timestamp").and_then(Value::as_str).unwrap_or("");
    let ms = parse_iso_ms(timestamp);
    scan.stats.note_time(ms);

    // Tool calls are partitioned across the split records rather than repeated,
    // so they are counted on every record — including ones whose usage is a
    // duplicate.
    if let Some(blocks) = message.get("content").and_then(Value::as_array) {
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let name = block.get("name").and_then(Value::as_str).unwrap_or("unknown");
            *scan.stats.tools.entry(name.to_string()).or_insert(0) += 1;
        }
    }

    // One usage object per API response, however many records carry it.
    let id = message.get("id").and_then(Value::as_str).unwrap_or("");
    if id.is_empty() || !scan.seen.insert(id.into()) {
        return;
    }

    let Some(usage) = message.get("usage") else {
        return;
    };
    let mut tokens = Tokens {
        input: as_u64(usage.get("input_tokens")),
        output: as_u64(usage.get("output_tokens")),
        cache_read: as_u64(usage.get("cache_read_input_tokens")),
        turns: 1,
        ..Tokens::default()
    };
    // The TTL split only exists in the nested object; the flat field is the
    // total. Falling back to the 5m rate under-reports rather than invents.
    let written = as_u64(usage.get("cache_creation_input_tokens"));
    let (write_5m, write_1h) = match usage.get("cache_creation") {
        Some(nested) if nested.is_object() => (
            as_u64(nested.get("ephemeral_5m_input_tokens")),
            as_u64(nested.get("ephemeral_1h_input_tokens")),
        ),
        _ => (written, 0),
    };
    if write_5m + write_1h == 0 {
        tokens.cache_write_5m = written;
    } else {
        tokens.cache_write_5m = write_5m;
        tokens.cache_write_1h = write_1h;
    }
    tokens.thinking = usage
        .get("output_tokens_details")
        .map(|details| as_u64(details.get("thinking_tokens")))
        .unwrap_or(0);

    let mut model = message
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    if usage.get("speed").and_then(Value::as_str) == Some("fast") {
        model.push_str(FAST_SUFFIX);
    }

    scan.stats.models.add(&model, &tokens);
    if timestamp.len() >= 10 {
        scan.stats
            .days
            .entry(timestamp[..10].to_string())
            .or_default()
            .add(&model, &tokens);
    }
}

/// Read whatever has been appended since the last pass. Returns bytes consumed.
fn scan_file(path: &Path, scan: &mut FileScan) -> std::io::Result<u64> {
    let size = fs::metadata(path)?.len();
    // A file that shrank was rewritten, not appended to, so the offset and the
    // dedup set no longer describe it.
    if size < scan.offset {
        *scan = FileScan::default();
    }
    if size == scan.offset {
        return Ok(0);
    }

    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(scan.offset))?;
    let mut buffer = Vec::with_capacity((size - scan.offset) as usize);
    file.read_to_end(&mut buffer)?;

    // A turn in flight leaves a half-written line at the end. Stop at the last
    // newline and leave the fragment for the next pass to re-read whole.
    let Some(last) = buffer.iter().rposition(|byte| *byte == b'\n') else {
        return Ok(0);
    };
    let complete = &buffer[..=last];
    // Lossy rather than strict: one mangled byte anywhere must not cost the
    // whole tail's numbers, and the substring tests only look at ASCII keys.
    for line in String::from_utf8_lossy(complete).lines() {
        ingest_line(line, scan);
    }
    scan.offset += complete.len() as u64;
    Ok(complete.len() as u64)
}

/* ---------- corpus walk ---------- */

/// One transcript on disk, tagged with the session it belongs to.
struct Transcript {
    path: PathBuf,
    project_dir: String,
    session_id: String,
    /// A subagent or workflow log, which rolls up into its parent session.
    is_agent: bool,
    size: u64,
}

fn collect_agent_logs(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_agent_logs(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

/// Every transcript under `~/.claude/projects`, sessions and subagents alike.
fn collect_transcripts() -> Vec<Transcript> {
    let mut found = Vec::new();
    let Some(root) = crate::sessions::projects_root() else {
        return found;
    };
    let Ok(projects) = fs::read_dir(&root) else {
        return found;
    };
    for project in projects.flatten() {
        let project_path = project.path();
        if !project_path.is_dir() {
            continue;
        }
        let project_dir = project.file_name().to_string_lossy().into_owned();
        let Ok(entries) = fs::read_dir(&project_path) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                // `<sessionId>/subagents/...` and the workflow logs below it.
                let mut logs = Vec::new();
                collect_agent_logs(&path, &mut logs);
                for log in logs {
                    let size = fs::metadata(&log).map(|m| m.len()).unwrap_or(0);
                    found.push(Transcript {
                        path: log,
                        project_dir: project_dir.clone(),
                        session_id: name.clone(),
                        is_agent: true,
                        size,
                    });
                }
            } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                found.push(Transcript {
                    path,
                    project_dir: project_dir.clone(),
                    session_id: name.trim_end_matches(".jsonl").to_string(),
                    is_agent: false,
                    size,
                });
            }
        }
    }
    found
}

/// MCP servers configured in `~/.claude.json`, globally or per project.
///
/// Read so the dashboard can say "configured but never called" — a server that
/// costs context on every startup and earns nothing is worth seeing.
fn configured_mcp_servers() -> HashSet<String> {
    let mut names = HashSet::new();
    let Some(path) = dirs::home_dir().map(|home| home.join(".claude.json")) else {
        return names;
    };
    let Ok(text) = fs::read_to_string(path) else {
        return names;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return names;
    };
    let mut absorb = |servers: Option<&Value>| {
        if let Some(map) = servers.and_then(Value::as_object) {
            for name in map.keys() {
                names.insert(name.clone());
            }
        }
    };
    absorb(value.get("mcpServers"));
    if let Some(projects) = value.get("projects").and_then(Value::as_object) {
        for project in projects.values() {
            absorb(project.get("mcpServers"));
        }
    }
    names
}

/* ---------- roll-up ---------- */

/// Tool name to MCP server, for the `mcp__<server>__<tool>` convention.
fn mcp_parts(tool: &str) -> Option<(&str, &str)> {
    let rest = tool.strip_prefix("mcp__")?;
    let (server, tool) = rest.split_once("__")?;
    Some((server, tool))
}

fn sorted_counts(counts: &BTreeMap<String, u64>) -> Vec<NameCount> {
    let mut rows: Vec<NameCount> = counts
        .iter()
        .map(|(name, count)| NameCount {
            name: name.clone(),
            count: *count,
        })
        .collect();
    rows.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
    rows
}

/// Group tool counts into per-server MCP rows, busiest server first.
fn mcp_rows(tools: &BTreeMap<String, u64>, configured: &HashSet<String>) -> Vec<McpStat> {
    let mut servers: BTreeMap<String, (u64, BTreeMap<String, u64>)> = BTreeMap::new();
    for (name, count) in tools {
        let Some((server, tool)) = mcp_parts(name) else {
            continue;
        };
        let entry = servers.entry(server.to_string()).or_default();
        entry.0 += count;
        *entry.1.entry(tool.to_string()).or_insert(0) += count;
    }
    let mut rows: Vec<McpStat> = servers
        .into_iter()
        .map(|(server, (calls, tools))| McpStat {
            configured: configured.contains(&server),
            server,
            calls,
            tools: sorted_counts(&tools),
        })
        .collect();
    rows.sort_by(|a, b| b.calls.cmp(&a.calls).then_with(|| a.server.cmp(&b.server)));
    rows
}

fn dominant_model(models: &ByModel) -> Option<String> {
    models
        .0
        .iter()
        .max_by_key(|(_, tokens)| tokens.output)
        .map(|(model, _)| model.clone())
}

/// Best-effort reverse of Claude Code's cwd escaping, for projects whose
/// transcripts never recorded a `cwd`.
fn label_for(project_dir: &str, cwd: &Option<String>) -> (String, String) {
    let path = cwd
        .clone()
        .unwrap_or_else(|| format!("/{}", project_dir.trim_start_matches('-').replace('-', "/")));
    let label = path
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .unwrap_or(project_dir)
        .to_string();
    (path, label)
}

/// One accumulator per repo while rolling sessions up.
#[derive(Default)]
struct ProjectAccumulator {
    models: ByModel,
    tools: BTreeMap<String, u64>,
    sessions: u64,
    agent_files: u64,
    first_ms: u64,
    last_ms: u64,
    size_bytes: u64,
    cwd: Option<String>,
}

/// Scan whatever has been appended since the last call and roll everything up.
///
/// The first call reads the whole corpus; later calls read only new bytes, so
/// the dashboard can refresh on the same watcher event the sidebar uses.
///
/// `async` so that walk runs off the main thread — the body stays synchronous,
/// the macro just moves it onto the threadpool. The dashboard asks for this on
/// mount and on every `sessions://changed`.
#[tauri::command(async)]
pub fn stats_summary(cache: State<'_, StatsCache>) -> Result<StatsSummary, String> {
    Ok(summarize(&cache))
}

/// The scan itself, free of Tauri's `State` so tests can drive it directly.
fn summarize(cache: &StatsCache) -> StatsSummary {
    // One walk at a time; see `StatsCache::scan_guard`. Taken before the corpus
    // listing so a queued caller also picks up files the first walk created.
    let _walk = cache.scan_guard.lock();
    let started = Instant::now();
    let transcripts = collect_transcripts();
    let configured = configured_mcp_servers();

    let mut files_read = 0u64;
    let mut bytes_read = 0u64;

    // Per session, then per repo. Sessions are keyed by id rather than by path
    // because a session and its subagent logs are different files.
    struct SessionAccumulator {
        project_dir: String,
        file: String,
        cwd: Option<String>,
        models: ByModel,
        agent_models: ByModel,
        tools: BTreeMap<String, u64>,
        user_messages: u64,
        agent_files: u64,
        first_ms: u64,
        last_ms: u64,
        size_bytes: u64,
    }

    let mut sessions: BTreeMap<String, SessionAccumulator> = BTreeMap::new();
    let mut projects: BTreeMap<String, ProjectAccumulator> = BTreeMap::new();
    let mut global = ByModel::default();
    let mut global_tools: BTreeMap<String, u64> = BTreeMap::new();
    let mut global_days: BTreeMap<String, ByModel> = BTreeMap::new();
    let mut live_paths: HashSet<PathBuf> = HashSet::new();
    let mut agent_file_count = 0u64;
    let mut total_bytes = 0u64;

    for transcript in &transcripts {
        live_paths.insert(transcript.path.clone());
        // The lock is taken twice per file — once to lend this file's resume
        // point out, once to hand it back — so neither the read nor the roll-up
        // below holds it. Held across the walk it would block every other
        // caller for as long as a cold corpus read takes; `scan_guard` above
        // serialises walks without doing that to readers of the map.
        let mut scan = cache.files.lock().remove(&transcript.path).unwrap_or_default();
        match scan_file(&transcript.path, &mut scan) {
            Ok(0) => {}
            Ok(read) => {
                files_read += 1;
                bytes_read += read;
            }
            // An unreadable transcript costs its own numbers, not the scan, so
            // its resume point goes back the way it came.
            Err(_) => {
                cache.files.lock().insert(transcript.path.clone(), scan);
                continue;
            }
        }
        let stats = &scan.stats;
        total_bytes += transcript.size;
        if transcript.is_agent {
            agent_file_count += 1;
        }

        let session = sessions
            .entry(transcript.session_id.clone())
            .or_insert_with(|| SessionAccumulator {
                project_dir: transcript.project_dir.clone(),
                file: transcript.path.to_string_lossy().into_owned(),
                cwd: None,
                models: ByModel::default(),
                agent_models: ByModel::default(),
                tools: BTreeMap::new(),
                user_messages: 0,
                agent_files: 0,
                first_ms: 0,
                last_ms: 0,
                size_bytes: 0,
            });
        if !transcript.is_agent {
            // The session's own transcript owns the path and the prompt count;
            // subagent logs contribute tokens and tools only.
            session.file = transcript.path.to_string_lossy().into_owned();
            session.user_messages += stats.user_messages;
        } else {
            session.agent_files += 1;
            session.agent_models.merge(&stats.models);
        }
        if session.cwd.is_none() {
            session.cwd = stats.cwd.clone();
        }
        session.models.merge(&stats.models);
        session.size_bytes += transcript.size;
        for (name, count) in &stats.tools {
            *session.tools.entry(name.clone()).or_insert(0) += count;
        }
        if stats.first_ms > 0 && (session.first_ms == 0 || stats.first_ms < session.first_ms) {
            session.first_ms = stats.first_ms;
        }
        session.last_ms = session.last_ms.max(stats.last_ms);

        let project = projects.entry(transcript.project_dir.clone()).or_default();
        project.models.merge(&stats.models);
        project.size_bytes += transcript.size;
        if project.cwd.is_none() {
            project.cwd = stats.cwd.clone();
        }
        if transcript.is_agent {
            project.agent_files += 1;
        }
        for (name, count) in &stats.tools {
            *project.tools.entry(name.clone()).or_insert(0) += count;
            *global_tools.entry(name.clone()).or_insert(0) += count;
        }
        if stats.first_ms > 0 && (project.first_ms == 0 || stats.first_ms < project.first_ms) {
            project.first_ms = stats.first_ms;
        }
        project.last_ms = project.last_ms.max(stats.last_ms);

        global.merge(&stats.models);
        for (day, models) in &stats.days {
            global_days.entry(day.clone()).or_default().merge(models);
        }
        cache.files.lock().insert(transcript.path.clone(), scan);
    }

    // Deleted transcripts must not keep contributing on the next call. Every
    // entry is back in the map by here — the loop returns each one before
    // moving on, error path included — and `scan_guard` rules out another walk
    // holding one out, so nothing escapes this by being checked out.
    cache.files.lock().retain(|path, _| live_paths.contains(path));

    let mut session_rows: Vec<SessionStats> = sessions
        .into_iter()
        .map(|(id, accumulator)| {
            let mcp_calls = accumulator
                .tools
                .iter()
                .filter(|(name, _)| mcp_parts(name).is_some())
                .map(|(_, count)| count)
                .sum();
            SessionStats {
                id,
                file: accumulator.file,
                project_dir: accumulator.project_dir,
                cwd: accumulator.cwd,
                model: dominant_model(&accumulator.models),
                tokens: accumulator.models.totals(),
                agent_files: accumulator.agent_files,
                agent_tokens: accumulator.agent_models.totals(),
                tool_calls: accumulator.tools.values().sum(),
                mcp_calls,
                user_messages: accumulator.user_messages,
                first_ms: accumulator.first_ms,
                last_ms: accumulator.last_ms,
                size_bytes: accumulator.size_bytes,
            }
        })
        .collect();
    session_rows.sort_by(|a, b| b.last_ms.cmp(&a.last_ms));

    for row in &session_rows {
        if let Some(project) = projects.get_mut(&row.project_dir) {
            project.sessions += 1;
        }
    }

    let mut project_rows: Vec<ProjectStats> = projects
        .into_iter()
        .map(|(dir_name, accumulator)| {
            let (cwd, label) = label_for(&dir_name, &accumulator.cwd);
            ProjectStats {
                dir_name,
                cwd,
                label,
                session_count: accumulator.sessions,
                agent_files: accumulator.agent_files,
                tokens: accumulator.models.totals(),
                models: accumulator.models.breakdown(),
                tools: sorted_counts(&accumulator.tools),
                mcp: mcp_rows(&accumulator.tools, &configured),
                first_ms: accumulator.first_ms,
                last_ms: accumulator.last_ms,
                size_bytes: accumulator.size_bytes,
            }
        })
        .collect();
    project_rows.sort_by(|a, b| {
        b.tokens
            .cost_usd
            .partial_cmp(&a.tokens.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mcp = mcp_rows(&global_tools, &configured);
    let used: HashSet<&str> = mcp.iter().map(|row| row.server.as_str()).collect();
    let mut unused_mcp_servers: Vec<String> = configured
        .iter()
        .filter(|name| !used.contains(name.as_str()))
        .cloned()
        .collect();
    unused_mcp_servers.sort();

    let days = global_days
        .into_iter()
        .map(|(day, models)| DayStat {
            day,
            tokens: models.totals(),
        })
        .collect();

    StatsSummary {
        tokens: global.totals(),
        models: global.breakdown(),
        tools: sorted_counts(&global_tools),
        mcp,
        days,
        session_count: session_rows.len() as u64,
        sessions: session_rows,
        projects: project_rows,
        agent_file_count,
        size_bytes: total_bytes,
        unused_mcp_servers,
        files_read,
        bytes_read,
        scan_ms: started.elapsed().as_millis() as u64,
        generated_at_ms: now_ms(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A single API response is written as one record per content block, each
    /// repeating the same usage object. Only one may be counted.
    #[test]
    fn split_records_count_once() {
        let mut scan = FileScan::default();
        let record = |block: &str| {
            format!(
                r#"{{"type":"assistant","timestamp":"2026-08-22T20:14:59.987Z","cwd":"/tmp/x","message":{{"role":"assistant","id":"msg_1","model":"claude-opus-5","content":[{block}],"usage":{{"input_tokens":10,"output_tokens":100,"cache_read_input_tokens":1000,"cache_creation":{{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":500}}}}}}}}"#
            )
        };
        ingest_line(&record(r#"{"type":"thinking","thinking":"x"}"#), &mut scan);
        ingest_line(
            &record(r#"{"type":"tool_use","id":"t1","name":"Bash","input":{}}"#),
            &mut scan,
        );
        ingest_line(
            &record(r#"{"type":"tool_use","id":"t2","name":"mcp__example__doc_read","input":{}}"#),
            &mut scan,
        );

        let totals = scan.stats.models.totals();
        assert_eq!(totals.turns, 1, "one API response, one turn");
        assert_eq!(totals.output, 100);
        assert_eq!(totals.cache_read, 1000);
        assert_eq!(totals.cache_write, 500);
        assert_eq!(totals.cache_write_1h, 500);
        // Tool calls are partitioned across records, so all of them count.
        assert_eq!(scan.stats.tools.values().sum::<u64>(), 2);
        assert_eq!(scan.stats.first_ms, parse_iso_ms("2026-08-22T20:14:59.987Z"));
    }

    #[test]
    fn prices_cache_tiers_apart() {
        let tokens = Tokens {
            input: 1_000_000,
            output: 0,
            cache_write_5m: 1_000_000,
            cache_write_1h: 1_000_000,
            cache_read: 1_000_000,
            thinking: 0,
            turns: 1,
        };
        let cost = cost_of(&tokens, price_for("claude-opus-5"));
        // 5 + 6.25 + 10 + 0.5 per million at the Opus input rate.
        assert!((cost - 21.75).abs() < 1e-9, "got {cost}");
        let plain = no_cache_cost_of(&tokens, price_for("claude-opus-5"));
        assert!((plain - 20.0).abs() < 1e-9, "got {plain}");
    }

    #[test]
    fn iso_parses_to_epoch_millis() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), 0);
        assert_eq!(parse_iso_ms("2026-08-22T20:14:59.987Z"), 1_787_429_699_987);
        assert_eq!(parse_iso_ms("not a timestamp"), 0);
    }

    /// Dumps a real summary to `/tmp/mangouste-stats.json`, for inspecting the
    /// payload the dashboard renders without running the app. Ignored by
    /// default: `cargo test dump_local_corpus -- --ignored`.
    #[test]
    #[ignore]
    fn dump_local_corpus() {
        let cache = StatsCache::default();
        let summary = summarize(&cache);
        let json = serde_json::to_string(&summary).expect("serialise");
        std::fs::write("/tmp/mangouste-stats.json", json).expect("write");
    }

    /// Scans the real corpus. Ignored by default — it reads every transcript on
    /// the machine, which is a benchmark, not a unit test.
    #[test]
    #[ignore]
    fn scans_local_corpus() {
        let cache = StatsCache::default();
        let first = summarize(&cache);
        eprintln!(
            "cold: {} files, {:.1} MB, {} ms | {} sessions, {} agent logs",
            first.files_read,
            first.bytes_read as f64 / 1e6,
            first.scan_ms,
            first.session_count,
            first.agent_file_count,
        );
        eprintln!(
            "tokens: in {} out {} write {} read {} | ${:.2} (uncached ${:.2})",
            first.tokens.input,
            first.tokens.output,
            first.tokens.cache_write,
            first.tokens.cache_read,
            first.tokens.cost_usd,
            first.tokens.no_cache_cost_usd,
        );
        for model in &first.models {
            eprintln!("  {} — ${:.2}", model.model, model.tokens.cost_usd);
        }
        for server in &first.mcp {
            eprintln!("  mcp {} — {} calls", server.server, server.calls);
        }
        let second = summarize(&cache);
        eprintln!("warm: {} files re-read, {} ms", second.files_read, second.scan_ms);
        assert_eq!(second.tokens.total, first.tokens.total, "warm rescan drifted");
    }
}
