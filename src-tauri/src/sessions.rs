//! Reads the Claude Code session store at `~/.claude/projects/<escaped-cwd>/<uuid>.jsonl`.
//!
//! Session files grow to megabytes, so nothing here reads a whole file: the
//! head supplies stable facts (`cwd`, `gitBranch`, `version`) and the tail
//! supplies the volatile ones (title, last prompt, liveness).

use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::State;

/// Bytes sampled from each end of a session file.
const HEAD_BYTES: u64 = 32 * 1024;
const TAIL_BYTES: u64 = 128 * 1024;

/// Whole lines re-read when the tail sample yielded no conversational record.
/// A single record longer than `TAIL_BYTES` (a pasted file, a giant tool result)
/// leaves the sample holding one truncated fragment and nothing else, so the
/// retry is by line count instead of byte count. Not the effective count: the
/// backwards scan that serves it adds its own `SLACK`, so it walks until it has
/// passed `TAIL_RETRY_LINES + SLACK` newlines, not this many.
const TAIL_RETRY_LINES: usize = 32;

/// Ceiling on how far back that scan may read, whatever it has found by then.
/// The line count cannot bound it: the retry fires precisely when records are
/// bigger than `TAIL_BYTES`, and a file made of those has its hundred-odd
/// newlines spread over most of its length — so an uncapped retry re-reads a
/// multi-MB transcript on every debounce tick of a live turn, with the cache
/// locks held. Capped, a record too long to fit yields nothing and the byte
/// sample stands, which is the same outcome as before the retry existed.
const TAIL_RETRY_BYTES: u64 = 8 * TAIL_BYTES;

/// Status thresholds, ported from the session-control-center extension, whose
/// state machine these mirror. The 90s mtime heuristic this replaces called a
/// long-running tool "idle" and a killed window "running".
///
/// Recent enough that a dangling turn means work is genuinely in flight.
const ACTIVE_WINDOW_MS: u64 = 5 * 60_000;
/// Beyond this a session is stale regardless of how it ended.
const IDLE_WINDOW_MS: u64 = 24 * 3_600_000;
/// Tool calls append nothing to the transcript while they run, so an unanswered
/// `tool_use` at the tail must be given far longer than ACTIVE_WINDOW_MS before
/// it is called interrupted — a build or a subagent fan-out legitimately runs
/// for tens of minutes.
const TOOL_RUNNING_GRACE_MS: u64 = 30 * 60_000;

/// `stop_reason` values that mean the turn closed cleanly. Notably excludes
/// `tool_use` (a tool is still running) and `pause_turn` (harness auto-continues).
const FINISHED_STOP_REASONS: [&str; 3] = ["end_turn", "stop_sequence", "refusal"];

/// Tools that block the agent ON the user until they reply.
const INPUT_PROMPT_TOOLS: [&str; 2] = ["AskUserQuestion", "ExitPlanMode"];

/// Prefix of the synthetic record Claude Code writes when you hit ESC. Covers
/// both "[Request interrupted by user]" and "...by user for tool use]".
const INTERRUPT_PREFIX: &str = "[Request interrupted by user";

/// Tag families Claude Code writes when echoing a UI command (`/model`, `/mcp`).
/// These are multi-tag blobs, corroborated by the matching closing tag.
const COMMAND_ECHO_FAMILIES: [&str; 2] = ["command-", "local-command"];

/// Standalone notices injected outside any human turn. A task notification can
/// land hours after a turn ended, and opening a file in the IDE writes a record
/// while the session just sits there — counting either as conversation flips
/// finished sessions to interrupted.
const STANDALONE_SYNTHETIC_TAGS: [&str; 3] =
    ["task-notification", "ide_opened_file", "ide_selection"];

/// Sidechain probes are re-run per scan for every non-idle session. Scans
/// overlap and repeat far faster than sidechain state meaningfully changes.
const PROBE_TTL_MS: u64 = 10_000;

/// A turn boundary puts `end_turn` at the tail for a moment before the next
/// record lands, so a scan in that window computes `finished` for a session that
/// is still working. Statuses only downgrade once the file has been quiet this
/// long. The pane re-polls every 15s, which is what re-evaluates a held status.
const HOT_FILE_GRACE_MS: u64 = 10_000;

/// `system` record subtypes that prove a turn is IN FLIGHT: API retry loops
/// write only these between attempts. Everything else a `system` record carries
/// is a post-hoc annotation written after the turn ended — `away_summary` lands
/// minutes late — so this is a whitelist, not a blacklist. Treating an unknown
/// subtype as liveness would drag the activity watermark past the end of the
/// turn; treating it as silence costs at worst an early `interrupted`, which the
/// tool grace already cushions.
const LIVENESS_SYSTEM_SUBTYPES: [&str; 2] = ["api_error", "model_refusal_fallback"];

/// Run-record statuses that mean the workflow is over. Its agents may have
/// flushed a moment ago, but nothing is running. An unknown or missing status is
/// treated as live: the worst case is a stale node that ages out of the active
/// window.
const TERMINAL_WORKFLOW_STATUSES: [&str; 6] =
    ["completed", "failed", "error", "cancelled", "killed", "stopped"];

/// One subagent whose sidechain log is being written right now.
///
/// Read from the log files rather than from the parent transcript's `Agent`
/// `tool_use` blocks: a mid-flight fan-out is exactly the case where the parent
/// has written nothing yet, and Workflow-tool agents have no per-agent
/// `tool_use` in the parent at all.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningAgent {
    /// Log basename without extension, e.g. `agent-3f9c`.
    pub id: String,
    pub agent_type: String,
    pub description: String,
    /// Absolute path of the agent's own transcript.
    pub file_path: String,
    pub mtime_ms: u64,
}

/// A Workflow-tool run with agents writing right now.
///
/// Workflow agents live one level deeper than Agent-tool ones, under
/// `<sessionId>/subagents/workflows/<runId>/`, and the sibling run record at
/// `<sessionId>/workflows/<runId>.json` supplies the name, phase and per-agent
/// labels their metas lack.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningWorkflow {
    pub run_id: String,
    pub name: Option<String>,
    pub status: Option<String>,
    pub phase: Option<String>,
    /// Agents spawned over the whole run, from the run record.
    pub agent_count: Option<u64>,
    pub newest_mtime_ms: u64,
    pub agents: Vec<RunningAgent>,
    pub json_path: Option<String>,
}

/// What one sidechain probe found. Never cached in `SessionMeta`: sidechains
/// move while the transcript that keys the parse cache sits still.
#[derive(Debug, Clone, Default)]
pub struct SidechainProbe {
    pub newest_mtime_ms: u64,
    pub running: Vec<RunningAgent>,
    pub workflows: Vec<RunningWorkflow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub file: String,
    pub project_dir: String,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub title: Option<String>,
    pub last_prompt: Option<String>,
    pub model: Option<String>,
    pub version: Option<String>,
    pub modified_ms: u64,
    /// Conversational watermark: the newest record's own timestamp, falling back
    /// to mtime when nothing timestamped was sampled.
    ///
    /// Distinct from `modified_ms` on purpose. Opening a session rewrites its log
    /// without adding conversation, and title regeneration and history snapshots
    /// bump mtime too — keying the read/unread overlay on mtime flipped
    /// already-reviewed sessions back to unreviewed.
    pub last_activity_ms: u64,
    pub size_bytes: u64,
    /// `running` | `waiting` | `idle`
    pub status: &'static str,
    /// Conversational records seen in the sampled tail.
    ///
    /// Exact only when the whole file fit in the sample; the corpus is ~224 MB
    /// across all transcripts, so counting every record on every scan is not
    /// worth it. `message_count_exact` tells the UI whether to show "48" or "48+".
    pub message_count: usize,
    pub message_count_exact: bool,
    /// Agent-tool subagents writing within the active window, newest first.
    pub running_agents: Vec<RunningAgent>,
    /// Workflow-tool runs with agents writing within the active window.
    pub running_workflows: Vec<RunningWorkflow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGroup {
    /// Directory name under `~/.claude/projects`, e.g. `-home-user-workspace-my-repo`.
    pub dir_name: String,
    /// Real working directory, taken from session entries when available.
    pub cwd: String,
    /// Last path segment, used as the sidebar label.
    pub label: String,
    pub sessions: Vec<SessionMeta>,
}

/// Everything `classify` needs, harvested once per parse.
///
/// Kept separate from `SessionMeta` because these are cache-stable — only the
/// derived `status` changes as wall-clock time passes.
#[derive(Clone, Default)]
struct StatusInputs {
    /// Role of the newest conversational record.
    last_conv_role: Option<String>,
    /// `stop_reason` of the newest assistant record.
    last_stop_reason: Option<String>,
    /// Newest assistant turn ended on a tool that blocks on the user.
    awaiting_input: bool,
    /// Newest conversational record is an ESC interrupt marker.
    interrupted: bool,
    /// Net queued prompts. A clean turn end with prompts still queued is not
    /// "your move" — the harness is about to dequeue and keep working.
    queue_depth: i64,
    /// Timestamp of the newest record, preferred over mtime for activity.
    ended_at_ms: u64,
}

/// One parsed session, plus the inputs needed to re-derive its status cheaply.
struct CachedSession {
    mtime: u64,
    size: u64,
    meta: SessionMeta,
    inputs: StatusInputs,
}

/// Parsed-session cache keyed by file path.
///
/// Without this, every filesystem event triggers a full re-parse of every
/// transcript on the machine — 144 files of up to 1.5 MB each, several times a
/// second while any session is streaming. Files are re-read only when their
/// mtime or size moves; everything else is served from here, and only the
/// time-dependent `status` field is recomputed.
#[derive(Default)]
pub struct SessionCache {
    entries: Mutex<HashMap<PathBuf, CachedSession>>,
    /// Sidechain probes, keyed by transcript path, with the time they were taken.
    ///
    /// Separate from `entries` because the two invalidate on different things: a
    /// parse is stale when the transcript moves, a probe is stale when its TTL
    /// expires. Entries for deleted sessions are dropped alongside the parses.
    probes: Mutex<HashMap<PathBuf, (u64, SidechainProbe)>>,
}

pub fn projects_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Best-effort reverse of Claude Code's cwd escaping.
///
/// The escaping is lossy (`/` and `-` both become `-`), so this is only a
/// fallback for sessions whose entries never recorded a `cwd`.
fn unescape_dir_name(dir_name: &str) -> String {
    format!("/{}", dir_name.trim_start_matches('-').replace('-', "/"))
}

fn read_head(path: &Path, len: u64) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let take = len.min(file.metadata()?.len());
    let mut buf = vec![0u8; take as usize];
    file.read_exact(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn read_tail(path: &Path, len: u64) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let start = size.saturating_sub(len);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity((size - start) as usize);
    file.read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    // A non-zero offset almost certainly lands mid-line; drop that fragment.
    if start > 0 {
        match text.find('\n') {
            Some(i) => Ok(text[i + 1..].to_string()),
            None => Ok(String::new()),
        }
    } else {
        Ok(text)
    }
}

fn parsed_lines(chunk: &str) -> Vec<serde_json::Value> {
    chunk
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .collect()
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_string)
}

/// True for the two record types a sample is mined for. A sample without one of
/// these carries no title, prompt, model or count, so it is worth re-reading.
fn is_conversational(record: &serde_json::Value) -> bool {
    matches!(str_field(record, "type").as_deref(), Some("user") | Some("assistant"))
}

/// Flatten a message's content to a short single-line preview.
fn preview_of(message: &serde_json::Value) -> Option<String> {
    let content = message.get("content")?;
    let text = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        None
    } else {
        Some(flat.chars().take(160).collect())
    }
}

/// Decide liveness from the tail of the transcript.
///
/// A file touched inside the active window whose last conversational entry is a
/// user turn means Claude is mid-response; an assistant turn means it is waiting
/// on the human. Anything older is idle regardless of the last entry.
/// Everything a session's sidechain says about what is running.
///
/// Background subagents write ONLY their own logs while the main transcript sits
/// at a clean turn end, so without this a session with a live fan-out reads as
/// finished while its agents are visibly working. Two levels are scanned:
/// `subagents/` for Agent-tool children and `subagents/workflows/<runId>/` for
/// Workflow-tool ones, which a flat read would miss entirely.
///
/// Deliberately not part of the parse cache — sidechains move while the
/// transcript does not — but TTL-cached, because scans repeat far faster than
/// any of this changes.
fn probe_sidechain(transcript: &Path, session_id: &str, now: u64) -> SidechainProbe {
    let Some(parent) = transcript.parent() else {
        return SidechainProbe::default();
    };
    let session_dir = parent.join(session_id);
    let dir = session_dir.join("subagents");

    let top = scan_agent_dir(&dir, now);
    let mut newest = top.0;
    let mut workflows: Vec<RunningWorkflow> = Vec::new();

    let run_ids = std::fs::read_dir(dir.join("workflows"))
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect::<Vec<_>>()
        })
        // No workflows subdirectory: the common case.
        .unwrap_or_default();

    for run_id in run_ids {
        let (run_newest, agents) = scan_agent_dir(&dir.join("workflows").join(&run_id), now);
        if run_newest == 0 {
            continue; // Empty run directory.
        }
        // Quiet for a whole active window: no agent of this run can be running
        // (`scan_agent_dir` already dropped them all) and an mtime this old
        // cannot make the session busy either, so the run record — hundreds of
        // kilobytes of script and result — is not worth opening.
        if now.saturating_sub(run_newest) > ACTIVE_WINDOW_MS {
            continue;
        }
        let record = read_workflow_record(&session_dir.join("workflows").join(format!("{run_id}.json")));
        // A terminal run's fresh mtimes are only its agents' final flush.
        // Counting them as liveness held the session active for a whole window
        // after the workflow ended.
        if record
            .as_ref()
            .and_then(|r| r.status.as_deref())
            .is_some_and(|status| TERMINAL_WORKFLOW_STATUSES.contains(&status))
        {
            continue;
        }
        newest = newest.max(run_newest);
        if agents.is_empty() {
            continue; // All quiet; the mtime above still counted.
        }
        // Workflow agent metas carry no description — the run record's progress
        // entries hold the per-agent labels.
        let agents = agents
            .into_iter()
            .map(|mut agent| {
                if agent.description.is_empty() {
                    if let Some(label) = record
                        .as_ref()
                        .and_then(|r| r.labels.get(agent.id.trim_start_matches("agent-")))
                    {
                        agent.description = label.clone();
                    }
                }
                agent
            })
            .collect();
        workflows.push(RunningWorkflow {
            run_id,
            name: record.as_ref().and_then(|r| r.name.clone()),
            status: record.as_ref().and_then(|r| r.status.clone()),
            phase: record.as_ref().and_then(|r| r.phase.clone()),
            agent_count: record.as_ref().and_then(|r| r.agent_count),
            newest_mtime_ms: run_newest,
            agents,
            json_path: record.as_ref().map(|r| r.json_path.clone()),
        });
    }

    workflows.sort_by(|a, b| b.newest_mtime_ms.cmp(&a.newest_mtime_ms));
    SidechainProbe { newest_mtime_ms: newest, running: top.1, workflows }
}

/// One flat directory of agent logs: newest mtime across them — bar a recent one
/// the agent's meta says was killed, whose final flush is not liveness — plus the
/// agents still writing inside the active window, newest first.
fn scan_agent_dir(dir: &Path, now: u64) -> (u64, Vec<RunningAgent>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, Vec::new());
    };
    let mut newest = 0u64;
    let mut running: Vec<RunningAgent> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        // A workflow run directory also holds `journal.jsonl`, which records the
        // run rather than an agent. Only `agent-*` logs are agents.
        if !path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|name| name.starts_with("agent-"))
        {
            continue;
        }
        let Some(mtime) = entry.metadata().ok().and_then(mtime_ms) else {
            continue; // Log vanished mid-probe.
        };
        // Quiet: a finished or dead agent. It still marks when this directory
        // last moved, but nothing else about it matters, so its meta is not read.
        if now.saturating_sub(mtime) > ACTIVE_WINDOW_MS {
            newest = newest.max(mtime);
            continue;
        }
        let Some(id) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };

        let mut agent_type = "agent".to_string();
        let mut description = String::new();
        // A killed agent's fresh mtime is just its final flush, so it is not
        // running however recent that write was — and, checked before the
        // watermark moves (mirroring the terminal-run skip above), it does not
        // hold the session active either.
        if let Some(meta) = std::fs::read_to_string(dir.join(format!("{id}.meta.json")))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        {
            if meta.get("stoppedByUser").and_then(|v| v.as_bool()) == Some(true) {
                continue;
            }
            if let Some(kind) = str_field(&meta, "agentType").filter(|k| !k.is_empty()) {
                agent_type = kind;
            }
            description = str_field(&meta, "description").unwrap_or_default();
        }
        newest = newest.max(mtime);

        running.push(RunningAgent {
            id,
            agent_type,
            description,
            file_path: path.to_string_lossy().to_string(),
            mtime_ms: mtime,
        });
    }

    running.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    (newest, running)
}

/// A Workflow run record, reduced to the fields the sidebar needs.
struct WorkflowRecord {
    json_path: String,
    name: Option<String>,
    status: Option<String>,
    phase: Option<String>,
    agent_count: Option<u64>,
    /// Agent id without the `agent-` prefix, mapped to its progress label.
    labels: HashMap<String, String>,
}

/// Best-effort read of `<sessionId>/workflows/<runId>.json`.
///
/// These embed the script and the result and run to hundreds of kilobytes, so
/// this is only called for runs whose agent directory was written inside the
/// active window. A torn mid-write read is not an error: the next probe retries.
fn read_workflow_record(json_path: &Path) -> Option<WorkflowRecord> {
    let text = std::fs::read_to_string(json_path).ok()?;
    let record: serde_json::Value = serde_json::from_str(&text).ok()?;

    let mut labels = HashMap::new();
    let mut phase = None;
    if let Some(progress) = record.get("workflowProgress").and_then(|p| p.as_array()) {
        for step in progress {
            match str_field(step, "type").as_deref() {
                // Last one wins: that is the phase the run is in now.
                Some("workflow_phase") => phase = str_field(step, "title").or(phase),
                Some("workflow_agent") => {
                    if let (Some(id), Some(label)) =
                        (str_field(step, "agentId"), str_field(step, "label"))
                    {
                        labels.insert(id, label);
                    }
                }
                _ => {}
            }
        }
    }

    Some(WorkflowRecord {
        json_path: json_path.to_string_lossy().to_string(),
        name: str_field(&record, "workflowName").filter(|n| !n.is_empty()),
        status: str_field(&record, "status"),
        phase,
        agent_count: record.get("agentCount").and_then(|c| c.as_u64()),
        labels,
    })
}

/// Epoch millis of a file's mtime.
fn mtime_ms(metadata: std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

/// Derive a session's status.
///
/// Port of `computeStatus` from the session-control-center extension. The
/// ordering matters: interrupted and awaiting are definitive at any recency, so
/// they are checked before the recency windows.
fn classify(
    inputs: &StatusInputs,
    last_activity_ms: u64,
    sidechain_ms: u64,
    now_ms: u64,
) -> &'static str {
    let age = now_ms.saturating_sub(last_activity_ms);

    // Stale: nothing has happened for a day.
    if age > IDLE_WINDOW_MS {
        return "idle";
    }
    // Explicit ESC. Definitive, so it cannot masquerade as active while recent.
    if inputs.interrupted {
        return "interrupted";
    }
    // Blocked on you until answered, however long that takes.
    if inputs.awaiting_input && inputs.last_conv_role.as_deref() == Some("assistant") {
        return "awaiting";
    }

    // A sidechain written more recently than the conversation, and recently in
    // absolute terms, means agents are still working.
    let sidechain_busy =
        sidechain_ms > last_activity_ms && now_ms.saturating_sub(sidechain_ms) <= ACTIVE_WINDOW_MS;

    // Clean end = newest record is an assistant message with a terminal
    // stop_reason. Anything else means the turn never closed.
    let clean_end = inputs.last_conv_role.as_deref() == Some("assistant")
        && inputs
            .last_stop_reason
            .as_deref()
            .is_some_and(|reason| FINISHED_STOP_REASONS.contains(&reason));

    if age <= ACTIVE_WINDOW_MS {
        if clean_end {
            // Queue depth is only trusted while recent: a live harness would
            // have dequeued within seconds, so an old positive depth is noise.
            return if inputs.queue_depth > 0 || sidechain_busy {
                "active"
            } else {
                "finished"
            };
        }
        // Dangling turn while recent: mid-stream or a tool is running.
        return "active";
    }

    if clean_end {
        return if sidechain_busy { "active" } else { "finished" };
    }

    // Dangling and quiet. An unanswered tool_use is normal silence, so hold
    // active through the tool grace window rather than flapping to interrupted.
    let tool_in_flight = inputs.last_conv_role.as_deref() == Some("assistant")
        && inputs.last_stop_reason.as_deref() == Some("tool_use");
    if tool_in_flight && (age <= TOOL_RUNNING_GRACE_MS.max(ACTIVE_WINDOW_MS) || sidechain_busy) {
        return "active";
    }

    // Truly stopped mid-turn: window died, API error, or an ESC with no marker.
    "interrupted"
}

/// Every text payload of a user message (string content or text blocks).
fn text_payloads(message: &serde_json::Value) -> Vec<&str> {
    match message.get("content") {
        Some(serde_json::Value::String(text)) => vec![text.as_str()],
        Some(serde_json::Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect(),
        _ => Vec::new(),
    }
}

/// True when one text payload is a synthetic echo rather than something typed.
fn is_synthetic_text(text: &str) -> bool {
    let trimmed = text.trim();
    if !trimmed.starts_with('<') {
        return false;
    }
    // Command echoes: opening tag plus the matching closing tag anywhere after.
    for family in COMMAND_ECHO_FAMILIES {
        if trimmed.starts_with(&format!("<{family}")) && trimmed.contains(&format!("</{family}")) {
            return true;
        }
    }
    // Standalone notices: the tag must be the ENTIRE payload, so a real prompt
    // that pastes such a block and adds commentary still counts as a prompt.
    for tag in STANDALONE_SYNTHETIC_TAGS {
        if trimmed.starts_with(&format!("<{tag}")) {
            let close = format!("</{tag}>");
            if let Some(index) = trimmed.find(&close) {
                if trimmed[index + close.len()..].trim().is_empty() {
                    return true;
                }
            }
        }
    }
    false
}

/// True when a user record opened no conversational turn.
///
/// Requires at least one text payload and that EVERY payload be synthetic: an
/// `ide_selection` block bundled with a typed prompt is still a real prompt.
fn is_synthetic_echo(message: &serde_json::Value) -> bool {
    let texts = text_payloads(message);
    !texts.is_empty() && texts.iter().all(|t| is_synthetic_text(t))
}

/// True when a user record is the synthetic ESC interrupt marker.
fn is_interrupt_marker(message: &serde_json::Value) -> bool {
    let starts = |text: &str| text.trim_start().starts_with(INTERRUPT_PREFIX);
    match message.get("content") {
        Some(serde_json::Value::String(text)) => starts(text),
        Some(serde_json::Value::Array(blocks)) => blocks.iter().any(|block| {
            block.get("type").and_then(|t| t.as_str()) == Some("text")
                && block.get("text").and_then(|t| t.as_str()).is_some_and(starts)
        }),
        _ => false,
    }
}

/// Walk the tail oldest-to-newest, last write wins.
///
/// Only the tail of the file is available, so `queue_depth` can miss an enqueue
/// whose dequeue is inside the window. It is clamped at zero, which biases
/// toward "finished" rather than a stuck "active".
fn status_inputs(tail: &[serde_json::Value]) -> StatusInputs {
    let mut inputs = StatusInputs::default();

    for record in tail {
        let record_type = str_field(record, "type");
        // Folded inside each arm rather than up front: a record skipped as
        // synthetic must not move the activity watermark either.
        let note_activity = |inputs: &mut StatusInputs| {
            if let Some(ms) = record
                .get("timestamp")
                .and_then(|t| t.as_str())
                .and_then(parse_timestamp_ms)
            {
                inputs.ended_at_ms = inputs.ended_at_ms.max(ms);
            }
        };

        match record_type.as_deref() {
            Some("assistant") => {
                note_activity(&mut inputs);
                inputs.last_conv_role = Some("assistant".to_string());
                // An assistant turn after an interrupt means work resumed; without
                // this the flag stuck and finished sessions read "interrupted".
                inputs.interrupted = false;
                let message = record.get("message");
                inputs.last_stop_reason = message
                    .and_then(|m| m.get("stop_reason"))
                    .and_then(|r| r.as_str())
                    .map(str::to_string);
                // Blocking tools are re-evaluated per assistant record, so the
                // flag stays true only while the prompt sits at the tail.
                inputs.awaiting_input = message
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                    .is_some_and(|blocks| {
                        blocks.iter().any(|block| {
                            block.get("type").and_then(|t| t.as_str()) == Some("tool_use")
                                && block
                                    .get("name")
                                    .and_then(|n| n.as_str())
                                    .is_some_and(|name| INPUT_PROMPT_TOOLS.contains(&name))
                        })
                    });
            }
            Some("user") => {
                // Command echoes and IDE/task injections are not turns. Counting
                // them made finished sessions read as active, then interrupted.
                if record.get("message").is_some_and(is_synthetic_echo) {
                    continue;
                }
                note_activity(&mut inputs);
                inputs.last_conv_role = Some("user".to_string());
                inputs.last_stop_reason = None;
                // A user record means the agent is no longer blocked on you.
                inputs.awaiting_input = false;
                inputs.interrupted = record.get("message").is_some_and(is_interrupt_marker);
            }
            // An API retry loop writes nothing but these between attempts, so
            // without them a long retry reads as a turn that stopped being
            // written. They move the watermark and nothing else.
            Some("system") => {
                if str_field(record, "subtype")
                    .is_some_and(|subtype| LIVENESS_SYSTEM_SUBTYPES.contains(&subtype.as_str()))
                {
                    note_activity(&mut inputs);
                }
            }
            Some("queue-operation") => match {
                note_activity(&mut inputs);
                str_field(record, "operation")
            }
            .as_deref()
            {
                Some("enqueue") => inputs.queue_depth += 1,
                Some("dequeue") | Some("remove") => {
                    inputs.queue_depth = (inputs.queue_depth - 1).max(0);
                }
                _ => {}
            },
            _ => {}
        }
    }
    inputs
}

/// Parse an RFC3339 timestamp to epoch millis without pulling in a date crate.
///
/// Transcript timestamps are always UTC `YYYY-MM-DDTHH:MM:SS(.sss)Z`.
fn parse_timestamp_ms(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let num = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let millis = text
        .split_once('.')
        .and_then(|(_, rest)| rest.get(..3))
        .and_then(|ms| ms.parse::<i64>().ok())
        .unwrap_or(0);

    // Days since epoch via the civil-from-days algorithm (Howard Hinnant).
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_adjusted = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_adjusted + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;

    let total = ((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000) + millis;
    u64::try_from(total).ok()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Parse one transcript's samples into a cache entry.
///
/// `status`, `running_agents` and `running_workflows` are left neutral: they
/// decay with wall-clock time, so `list_sessions` recomputes them on every scan
/// from a TTL-cached probe, cache hit or miss. Probing here would be thrown away.
fn read_session(path: &Path, project_dir: &str) -> Option<CachedSession> {
    let metadata = std::fs::metadata(path).ok()?;
    let size_bytes = metadata.len();
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let id = path.file_stem()?.to_string_lossy().to_string();
    let head = parsed_lines(&read_head(path, HEAD_BYTES).ok()?);
    let mut tail = parsed_lines(&read_tail(path, TAIL_BYTES).ok()?);
    // The byte sample keeps only whole lines, so one record longer than
    // TAIL_BYTES leaves nothing behind it and title, prompt, model, count and
    // the activity watermark all come back empty. Retry by line instead — under
    // a byte ceiling, because this path runs on every scan of a live session
    // whose records are by definition huge — and adopt the retry only when it
    // found conversation: the byte sample covers more of the file, so a tail
    // carrying other records is still the better one to mine.
    if !tail.iter().any(is_conversational) {
        if let Some(lines) = read_last_lines(path, TAIL_RETRY_LINES, Some(TAIL_RETRY_BYTES))
            .ok()
            .map(|text| parsed_lines(&text))
            .filter(|records| records.iter().any(is_conversational))
        {
            tail = lines;
        }
    }

    // Stable facts: first entry that carries them wins.
    let find_head = |key: &str| head.iter().find_map(|v| str_field(v, key));
    let cwd = find_head("cwd").or_else(|| tail.iter().find_map(|v| str_field(v, "cwd")));
    let version = find_head("version");

    // Volatile facts: last occurrence in the tail wins.
    let find_tail = |key: &str| tail.iter().rev().find_map(|v| str_field(v, key));
    let git_branch = find_tail("gitBranch").or_else(|| find_head("gitBranch"));
    // An explicit rename (`--name`, `/rename`, or our own post-turn record)
    // outranks the CLI's rolling AI title, matching the CLI picker. Title
    // records are written once, not re-appended on resume, so a long session's
    // only one can sit outside both samples — hence the head fallbacks, which
    // beat rendering a bare uuid. Both samples prefer their newest record.
    let record_title_in = |records: &[serde_json::Value], kind: &str, field: &str| {
        records
            .iter()
            .rev()
            .find(|v| str_field(v, "type").as_deref() == Some(kind))
            .and_then(|v| str_field(v, field))
    };
    let title = record_title_in(&tail, "custom-title", "customTitle")
        .or_else(|| record_title_in(&tail, "ai-title", "aiTitle"))
        .or_else(|| record_title_in(&head, "custom-title", "customTitle"))
        .or_else(|| record_title_in(&head, "ai-title", "aiTitle"));

    let model = tail.iter().rev().find_map(|v| {
        (str_field(v, "type").as_deref() == Some("assistant"))
            .then(|| v.get("message").and_then(|m| str_field(m, "model")))
            .flatten()
    });

    // Prefer the explicit `last-prompt` marker; fall back to the newest user turn.
    let last_prompt = find_tail("lastPrompt").or_else(|| {
        tail.iter()
            .rev()
            .filter(|v| str_field(v, "type").as_deref() == Some("user"))
            .find_map(|v| v.get("message").and_then(preview_of))
    });

    let message_count = tail.iter().filter(|v| is_conversational(v)).count();

    let inputs = status_inputs(&tail);
    // Prefer the newest record's own timestamp over mtime: an editor touching
    // the file, or a flush long after the turn, must not read as activity.
    let last_activity_ms = if inputs.ended_at_ms > 0 {
        inputs.ended_at_ms
    } else {
        modified_ms
    };

    Some(CachedSession {
        mtime: modified_ms,
        size: size_bytes,
        inputs,
        meta: SessionMeta {
            id,
            file: path.to_string_lossy().to_string(),
            project_dir: project_dir.to_string(),
            cwd,
            git_branch,
            title,
            last_prompt,
            model,
            version,
            modified_ms,
            last_activity_ms,
            size_bytes,
            // Placeholders; `list_sessions` fills all three in per scan.
            status: "idle",
            message_count,
            message_count_exact: size_bytes <= TAIL_BYTES,
            running_agents: Vec::new(),
            running_workflows: Vec::new(),
        },
    })
}

/// Hold a live status through the turn-boundary flicker.
///
/// At the instant a turn's `end_turn` is the tail of the file, the next record is
/// milliseconds away — or mid-write, and so skipped as a partial line. A scan
/// landing there computes `finished` for a session that never stopped working.
/// Downgrades therefore wait for the file to go quiet for `HOT_FILE_GRACE_MS`;
/// the pane's 15s poll is what re-evaluates a held status, and it always
/// outlasts the grace.
fn apply_downgrade_grace(
    previous: Option<&'static str>,
    computed: &'static str,
    mtime_ms: u64,
    now: u64,
) -> &'static str {
    let was_live = matches!(previous, Some("active") | Some("awaiting"));
    let went_quiet = computed == "finished";
    if was_live && went_quiet && now.saturating_sub(mtime_ms) < HOT_FILE_GRACE_MS {
        return previous.unwrap_or(computed);
    }
    computed
}

/// Scan every project directory and return groups sorted alphabetically by label.
///
/// `async` so the scan — stat, sample, and sidechain probes across every
/// transcript on the machine — runs off the main thread.
#[tauri::command(async)]
pub fn list_sessions(cache: State<'_, SessionCache>) -> Result<Vec<ProjectGroup>, String> {
    let root = projects_root().ok_or("no home directory")?;
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let now = now_ms();
    let mut groups: BTreeMap<String, ProjectGroup> = BTreeMap::new();
    let mut entries = cache.entries.lock();
    let mut probes = cache.probes.lock();
    let mut seen: Vec<PathBuf> = Vec::new();

    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.path().is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        let mut sessions = Vec::new();

        let files = match std::fs::read_dir(entry.path()) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            seen.push(path.clone());

            // Serve from cache unless the file actually moved.
            let fresh = std::fs::metadata(&path).ok().is_some_and(|m| {
                let mtime = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                entries
                    .get(&path)
                    .is_some_and(|c| c.mtime == mtime && c.size == m.len())
            });

            // Captured before the re-parse overwrites it: the grace below needs
            // to know what this session read as a moment ago.
            let previous_status = entries.get(&path).map(|c| c.meta.status);

            if !fresh {
                if let Some(parsed) = read_session(&path, &dir_name) {
                    entries.insert(path.clone(), parsed);
                }
            }

            if let Some(cached) = entries.get_mut(&path) {
                // Status decays with wall-clock time, so re-derive it even on a
                // cache hit. Sidechains are probed fresh: subagent logs move
                // while the main transcript sits still, and that is exactly the
                // case a cached status would get wrong.
                let last_activity_ms = if cached.inputs.ended_at_ms > 0 {
                    cached.inputs.ended_at_ms
                } else {
                    cached.mtime
                };
                let probe = if now.saturating_sub(last_activity_ms) > IDLE_WINDOW_MS {
                    // Long-dead session: nothing can be running under it, so
                    // skip the walk entirely.
                    probes.remove(&path);
                    SidechainProbe::default()
                } else {
                    match probes.get(&path) {
                        Some((at, probe)) if now.saturating_sub(*at) < PROBE_TTL_MS => probe.clone(),
                        _ => {
                            let probe = probe_sidechain(&path, &cached.meta.id, now);
                            probes.insert(path.clone(), (now, probe.clone()));
                            probe
                        }
                    }
                };
                let computed =
                    classify(&cached.inputs, last_activity_ms, probe.newest_mtime_ms, now);
                cached.meta.status =
                    apply_downgrade_grace(previous_status, computed, cached.mtime, now);
                cached.meta.running_agents = probe.running;
                cached.meta.running_workflows = probe.workflows;
                sessions.push(cached.meta.clone());
            }
        }
        if sessions.is_empty() {
            continue;
        }
        // The conversational watermark, never mtime: a rename or a title
        // regeneration bumps mtime without adding conversation, which sorted
        // rows above the age they print.
        sessions.sort_by(|a, b| b.last_activity_ms.cmp(&a.last_activity_ms));

        let cwd = sessions
            .iter()
            .find_map(|s| s.cwd.clone())
            .unwrap_or_else(|| unescape_dir_name(&dir_name));
        // Sessions spawned by the background title generator are tooling,
        // not conversations; the whole scratch group stays hidden.
        if Path::new(&cwd) == crate::chats::titlegen_dir() {
            continue;
        }
        let label = Path::new(&cwd)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| cwd.clone());

        groups.insert(
            dir_name.clone(),
            ProjectGroup { dir_name, cwd, label, sessions },
        );
    }

    // Drop cache entries for transcripts that no longer exist. Unconditional:
    // a same-scan delete-and-create keeps the lengths equal while an entry is
    // stale, so a length check would skip exactly the evictions that matter.
    let live: std::collections::HashSet<&PathBuf> = seen.iter().collect();
    entries.retain(|path, _| live.contains(path));
    probes.retain(|path, _| live.contains(path));

    let mut out: Vec<ProjectGroup> = groups.into_values().collect();
    // Alphabetical by label, never by activity: a row that moves while you are
    // reading it costs more than any ordering by recency buys. `dir_name`
    // breaks ties so two repos sharing a leaf name keep a stable order.
    out.sort_by(|a, b| {
        a.label
            .to_lowercase()
            .cmp(&b.label.to_lowercase())
            .then_with(|| a.dir_name.cmp(&b.dir_name))
    });
    Ok(out)
}

/// Text covering the last `count` lines of a file (plus slack for blank or
/// malformed ones), found by scanning backwards from EOF in chunks so a
/// multi-MB transcript is neither read nor parsed in full.
///
/// `max_bytes` caps the walk for callers whose files may be made of records long
/// enough that a line count is no bound at all; it then returns whatever whole
/// lines fell inside the cap, possibly none. `None` walks back as far as it must
/// to find the lines, which is what a caller asked for exactly `count` entries
/// needs.
fn read_last_lines(path: &Path, count: usize, max_bytes: Option<u64>) -> std::io::Result<String> {
    const CHUNK: u64 = 64 * 1024;
    /// Extra lines beyond `count`, absorbing ones `parsed_lines` will drop.
    const SLACK: usize = 64;

    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let wanted = count.saturating_add(SLACK);
    // Earliest offset the walk may read from; `None` means the whole file.
    let floor = size.saturating_sub(max_bytes.unwrap_or(u64::MAX));
    let mut end = size;
    let mut newlines = 0usize;
    // Newest chunk first, joined once at the end. Prepending each chunk to a
    // running buffer instead re-copies everything collected so far, so a long
    // walk spends quadratically more on memcpy than on the read it is there for.
    let mut chunks: Vec<Vec<u8>> = Vec::new();

    while end > floor && newlines <= wanted {
        let start = end.saturating_sub(CHUNK).max(floor);
        let mut buf = vec![0u8; (end - start) as usize];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut buf)?;
        newlines += buf.iter().filter(|&&b| b == b'\n').count();
        chunks.push(buf);
        end = start;
    }

    let mut collected: Vec<u8> = Vec::with_capacity((size - end) as usize);
    for chunk in chunks.iter().rev() {
        collected.extend_from_slice(chunk);
    }
    let text = String::from_utf8_lossy(&collected).into_owned();
    // A chunk boundary almost certainly lands mid-line; drop that fragment.
    if end > 0 {
        return Ok(match text.find('\n') {
            Some(i) => text[i + 1..].to_string(),
            None => String::new(),
        });
    }
    Ok(text)
}

/// Read one session transcript in full, newest entries last.
///
/// `limit` caps how many conversational entries come back, counted from the end.
#[tauri::command(async)]
pub fn read_session_transcript(
    file: String,
    limit: Option<usize>,
) -> Result<Vec<serde_json::Value>, String> {
    let path = PathBuf::from(&file);
    let text = match limit {
        // Only the tail is wanted: read backwards from EOF instead of
        // slurping and JSON-parsing the whole file. Uncapped: a view asking for
        // `limit` entries has to get them however long the records are.
        Some(limit) => read_last_lines(&path, limit, None).map_err(|e| e.to_string())?,
        None => std::fs::read_to_string(&path).map_err(|e| e.to_string())?,
    };
    let mut entries = parsed_lines(&text);
    if let Some(limit) = limit {
        if entries.len() > limit {
            entries.drain(..entries.len() - limit);
        }
    }
    Ok(entries)
}

/* ---------- transcript content search ---------- */
//
// The sidebar's own filter matches what a scan already holds — title, last
// prompt, branch, id. That covers "the session I remember naming", and nothing
// else: the words you actually recall are usually three prompts deep in a
// transcript the scan never sampled. This is the escalation for that case, and
// it is deliberately a separate explicit command rather than part of the scan:
// the corpus is ~300 MB across ~500 files, which is fine to sweep when a human
// pressed Enter and ruinous on every watcher event.
//
// Matching is scoped to conversation — user prompts and assistant text — not to
// raw lines. Grepping raw lines would make every session that ever ran `cat` on
// a file a hit for that file's contents, which buries the sessions that
// discussed it. The cost of that scoping is paid with a two-stage test per line:
// a byte-level case-insensitive scan first, and a JSON parse only of the few
// lines that survive it.

/// Bytes scanned per transcript. A megabyte-per-record file (pasted logs, giant
/// tool results) is not worth an unbounded read on a keystroke-driven path; the
/// head is where the conversation that names a session lives anyway.
const SEARCH_FILE_CAP_BYTES: u64 = 32 * 1024 * 1024;

/// Lines longer than this are matched bytewise but never parsed. A record this
/// big is a payload, not a sentence, and `serde_json` on it costs more than the
/// snippet is worth.
const SEARCH_PARSE_LINE_CAP: usize = 256 * 1024;

/// Snippets kept per session. Only the first is shown; the rest are for the
/// tooltip, and the count stops the parse work growing with a chatty match.
const SEARCH_SNIPPETS_PER_SESSION: usize = 3;

/// Characters of context kept either side of the matched term.
const SNIPPET_CONTEXT_CHARS: usize = 90;

/// Threads used for the sweep. Files are handed out from a shared cursor rather
/// than pre-chunked: transcripts differ in size by three orders of magnitude, so
/// a static split leaves one thread holding every big file.
const SEARCH_THREADS: usize = 8;

/// One transcript that matched, with the evidence for it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHit {
    /// Session uuid — the file stem, which is what the sidebar keys rows on.
    pub id: String,
    pub file: String,
    pub dir_name: String,
    /// Conversational records that contained at least one term.
    pub match_count: usize,
    /// Matching text, trimmed to a window around the first term.
    pub snippet: String,
    /// `user` | `assistant` — who said the snippet.
    pub role: String,
    /// Every distinct snippet found, first N only. Feeds the row tooltip.
    pub snippets: Vec<String>,
}

/// How a multi-term query is combined.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MatchMode {
    /// Every term must appear somewhere in the session. The default: it is what
    /// makes a longer query narrow the result set rather than widen it.
    All,
    /// Any term matches. Used by the Haiku escalation, whose terms are guesses
    /// at what you might have said, not things you know you did.
    Any,
}

/// Case-insensitive substring search over bytes.
///
/// ASCII-only folding on purpose: the terms come from a search box and the
/// haystack is JSON, so this is the same fold `contains` after `to_lowercase`
/// would give for realistic queries, without allocating a lowercase copy of
/// every line of a 300 MB corpus.
fn find_ci(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    // First-byte skip before the full compare: on a corpus this size the loop
    // spends nearly all its time rejecting positions, and `windows().position()`
    // pays a case-folding compare of the whole needle at every one of them.
    let lower = needle[0].to_ascii_lowercase();
    let upper = needle[0].to_ascii_uppercase();
    let last = haystack.len() - needle.len();
    for index in 0..=last {
        let byte = haystack[index];
        if (byte == lower || byte == upper)
            && haystack[index..index + needle.len()].eq_ignore_ascii_case(needle)
        {
            return Some(index);
        }
    }
    None
}

fn contains_ci(haystack: &str, needle: &str) -> bool {
    find_ci(haystack.as_bytes(), needle.as_bytes()).is_some()
}

/// Split a query into terms: whitespace-separated, with `"quoted phrases"` kept
/// whole so a phrase can be searched as one term.
fn search_terms(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in query.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                if !quoted && !current.is_empty() {
                    terms.push(std::mem::take(&mut current));
                }
            }
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    terms.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        terms.push(current);
    }
    terms
}

/// A window of `text` around the first term that matches it, whitespace
/// collapsed, with ellipses where it was cut.
fn snippet_around(text: &str, terms: &[String]) -> Option<String> {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let at = terms.iter().filter_map(|t| find_ci(flat.as_bytes(), t.as_bytes())).min()?;
    // Byte offset to char offset, then a char window: the transcript is UTF-8
    // and slicing it on a byte boundary would panic on any multi-byte match.
    let chars: Vec<char> = flat.chars().collect();
    let at_char = flat[..at].chars().count();
    let start = at_char.saturating_sub(SNIPPET_CONTEXT_CHARS);
    let end = (at_char + SNIPPET_CONTEXT_CHARS).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..end]);
    if end < chars.len() {
        out.push('…');
    }
    Some(out)
}

/// Scan one transcript. `None` when it does not satisfy `mode`.
fn search_one(path: &Path, dir_name: &str, terms: &[String], mode: MatchMode) -> Option<SessionHit> {
    let file = File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file.take(SEARCH_FILE_CAP_BYTES));
    let mut line: Vec<u8> = Vec::new();
    let mut seen_terms = vec![false; terms.len()];
    let mut match_count = 0usize;
    let mut snippets: Vec<String> = Vec::new();
    let mut role = String::new();

    loop {
        line.clear();
        match std::io::BufRead::read_until(&mut reader, b'\n', &mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        // Stage one: is any term anywhere in the raw line? Almost every line
        // fails here, and failing here costs no allocation and no parse.
        if !terms.iter().any(|t| find_ci(&line, t.as_bytes()).is_some()) {
            continue;
        }
        if line.len() > SEARCH_PARSE_LINE_CAP {
            continue;
        }
        // Stage two: confirm the hit is in something that was said, not in a
        // tool result or a file the session happened to read.
        let Ok(record) = serde_json::from_slice::<serde_json::Value>(&line) else {
            continue;
        };
        if !is_conversational(&record) {
            continue;
        }
        let Some(message) = record.get("message") else { continue };
        if is_synthetic_echo(message) {
            continue;
        }
        let payloads = text_payloads(message);
        if payloads.is_empty() {
            continue;
        }
        let mut hit_here = false;
        for (index, term) in terms.iter().enumerate() {
            if payloads.iter().any(|text| contains_ci(text, term)) {
                seen_terms[index] = true;
                hit_here = true;
            }
        }
        if !hit_here {
            continue;
        }
        match_count += 1;
        if snippets.len() < SEARCH_SNIPPETS_PER_SESSION {
            let joined = payloads.join(" ");
            if let Some(snippet) = snippet_around(&joined, terms) {
                if !snippets.contains(&snippet) {
                    if snippets.is_empty() {
                        role = str_field(&record, "type").unwrap_or_default();
                    }
                    snippets.push(snippet);
                }
            }
        }
    }

    let satisfied = match mode {
        MatchMode::All => seen_terms.iter().all(|seen| *seen),
        MatchMode::Any => seen_terms.iter().any(|seen| *seen),
    };
    if !satisfied || match_count == 0 {
        return None;
    }
    Some(SessionHit {
        id: path.file_stem()?.to_string_lossy().to_string(),
        file: path.to_string_lossy().to_string(),
        dir_name: dir_name.to_string(),
        match_count,
        snippet: snippets.first().cloned().unwrap_or_default(),
        role,
        snippets,
    })
}

/// Every transcript under the projects root, paired with its project dir name.
fn all_transcripts() -> Vec<(PathBuf, String)> {
    let Some(root) = projects_root() else { return Vec::new() };
    let Ok(dirs) = std::fs::read_dir(&root) else { return Vec::new() };
    let mut out = Vec::new();
    for dir in dirs.flatten() {
        let path = dir.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = dir.file_name().to_string_lossy().to_string();
        let Ok(files) = std::fs::read_dir(&path) else { continue };
        for file in files.flatten() {
            let file_path = file.path();
            if file_path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                out.push((file_path, dir_name.clone()));
            }
        }
    }
    out
}

/// Search inside every transcript for `query`.
///
/// Returns hits sorted by match count, most first. `any_term` switches the
/// combining rule from "every term" to "any term" — see `MatchMode`.
#[tauri::command(async)]
pub fn search_sessions(
    query: String,
    any_term: Option<bool>,
    limit: Option<usize>,
) -> Result<Vec<SessionHit>, String> {
    let terms = search_terms(&query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let mode = if any_term.unwrap_or(false) { MatchMode::Any } else { MatchMode::All };
    let files = all_transcripts();
    let next = std::sync::atomic::AtomicUsize::new(0);
    let hits = Mutex::new(Vec::<SessionHit>::new());
    let threads = SEARCH_THREADS.min(files.len().max(1));

    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some((path, dir_name)) = files.get(index) else { break };
                if let Some(hit) = search_one(path, dir_name, &terms, mode) {
                    hits.lock().push(hit);
                }
            });
        }
    });

    let mut out = hits.into_inner();
    // Most-discussed first: a session that said it once is a weaker answer than
    // one that came back to it repeatedly. The sidebar re-sorts within its own
    // groups anyway, so this only decides what survives `limit`.
    out.sort_by(|a, b| b.match_count.cmp(&a.match_count).then(a.id.cmp(&b.id)));
    if let Some(limit) = limit {
        out.truncate(limit);
    }
    Ok(out)
}

#[cfg(test)]
mod search_tests {
    use super::*;

    #[test]
    fn quoted_phrases_stay_one_term() {
        assert_eq!(search_terms("auth token"), vec!["auth", "token"]);
        assert_eq!(search_terms("  \"rate limit\" retry "), vec!["rate limit", "retry"]);
        assert_eq!(search_terms("   "), Vec::<String>::new());
    }

    #[test]
    fn matching_folds_ascii_case() {
        assert_eq!(find_ci(b"the SessionsPane row", b"sessionspane"), Some(4));
        assert_eq!(find_ci(b"nothing here", b"absent"), None);
        // A prefix that keeps failing at the last byte is the case the
        // first-byte skip must still get right.
        assert_eq!(find_ci(b"aaab", b"aab"), Some(1));
    }

    #[test]
    fn snippet_windows_multibyte_text_without_panicking() {
        let text = format!("{} needle {}", "é".repeat(200), "ü".repeat(200));
        let snippet = snippet_around(&text, &["needle".to_string()]).expect("a snippet");
        assert!(snippet.contains("needle"));
        assert!(snippet.starts_with('…') && snippet.ends_with('…'));
        // Both sides are trimmed to the context window, plus the two ellipses.
        assert_eq!(snippet.chars().count(), SNIPPET_CONTEXT_CHARS * 2 + 2);
    }

    /// Sweeps the real corpus. Ignored by default — it reads every transcript on
    /// the machine, which is a benchmark, not a unit test:
    /// `cargo test searches_local_corpus -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn searches_local_corpus() {
        let start = std::time::Instant::now();
        let hits = search_sessions("search box sidebar".into(), None, Some(5)).expect("a sweep");
        eprintln!("{} hits in {:?}", hits.len(), start.elapsed());
        for hit in &hits {
            eprintln!("  {} x{} [{}] {}", hit.id, hit.match_count, hit.role, hit.snippet);
        }
    }

    #[test]
    fn scopes_matches_to_conversation() {
        let dir = std::env::temp_dir().join("mangouste-search-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("11111111-2222-3333-4444-555555555555.jsonl");
        let lines = [
            // Said out loud: matches.
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"the migration keeps deadlocking"}]}}"#,
            // Same word, but only inside a tool result — a file the session read
            // is not a thing the session discussed.
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"deadlocking deadlocking"}]}}"#,
            // Synthetic echo of a slash command: not conversation either.
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<command-name>/deadlocking</command-name>"}]}}"#,
        ];
        std::fs::write(&path, format!("{}\n", lines.join("\n"))).expect("write transcript");

        let terms = vec!["deadlocking".to_string()];
        let hit = search_one(&path, "-tmp", &terms, MatchMode::All).expect("a hit");
        assert_eq!(hit.match_count, 1, "only the spoken record counts");
        assert!(hit.snippet.contains("deadlocking"));
        assert_eq!(hit.role, "user");
        assert_eq!(hit.id, "11111111-2222-3333-4444-555555555555");

        // AND across terms holds within a file; ANY is the escalation's rule.
        let both = vec!["migration".to_string(), "absent".to_string()];
        assert!(search_one(&path, "-tmp", &both, MatchMode::All).is_none());
        assert!(search_one(&path, "-tmp", &both, MatchMode::Any).is_some());

        std::fs::remove_file(&path).ok();
    }
}
