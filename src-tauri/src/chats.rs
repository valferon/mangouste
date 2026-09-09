//! Owns every `claude` child, in the GUI process.
//!
//! An earlier design ran these in a detached daemon so sessions could outlive
//! the window. That was dropped deliberately: a chat that keeps burning tokens
//! after you close the app is invisible spend, and the daemon's idle reaper
//! could never fire while a chat was alive, so "temporarily detached" was in
//! practice "forever". Children now live and die with the window that started
//! them — see `Chat::owner`, and `kill_owned_by` below.
//!
//! What the daemon got right is kept: each child gets its own process group, so
//! teardown signals the CLI's whole subtree rather than just the node process at
//! its root.
//!
//! A session uuid used to double as an alias for its chat, so a sidebar resume
//! could attach to the process already running that transcript. It never fired:
//! every id on the wire is the pane's own `chat|<cwd>|<key>`, never a bare uuid,
//! so the alias was unreachable — and a chat is now killed when its tab closes,
//! so no orphan survives to be resumed in the first place.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::permission::{PermissionRequest, PermissionState};

pub const EVENT_MESSAGE: &str = "claude://message";
pub const EVENT_STDERR: &str = "claude://stderr";
pub const EVENT_EXIT: &str = "claude://exit";
pub const EVENT_TOOL_ACTIVITY: &str = "claude://tool-activity";
pub const EVENT_DEBUG: &str = "claude://debug";

pub fn runtime_dir() -> PathBuf {
    if let Ok(base) = std::env::var("XDG_RUNTIME_DIR") {
        if !base.is_empty() {
            return PathBuf::from(base).join("mangouste");
        }
    }
    // No XDG dir. /tmp itself is world-writable, so a shared /tmp/mangouste
    // could be pre-created by another local user, who would then own the
    // permission socket and could auto-approve tool calls. Fall back to a
    // per-uid directory instead, created 0700 and verified before use.
    let uid = unsafe { libc::getuid() };
    let dir = PathBuf::from(format!("/tmp/mangouste-{uid}"));
    if secure_private_dir(&dir, uid) {
        return dir;
    }
    // Hijacked or unfixable: use a home-scoped directory nobody else can own.
    if let Some(home) = dirs::home_dir() {
        let fallback = home.join(".mangouste").join("run");
        if secure_private_dir(&fallback, uid) {
            return fallback;
        }
    }
    dir
}

/// Ensure `dir` exists, is a real directory (not a symlink) owned by `uid`,
/// and is closed to group and world. Never reports an unsafe dir as usable.
fn secure_private_dir(dir: &Path, uid: u32) -> bool {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    let _ = std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir);
    let Ok(metadata) = std::fs::symlink_metadata(dir) else {
        return false;
    };
    if !metadata.is_dir() || metadata.uid() != uid {
        return false;
    }
    if metadata.mode() & 0o077 != 0 {
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        return std::fs::symlink_metadata(dir)
            .map(|m| m.mode() & 0o077 == 0)
            .unwrap_or(false);
    }
    true
}

fn chat_hash(chat_id: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in chat_id.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

/// Per-chat MCP config, named so teardown can find and delete it.
fn mcp_config_path(chat_id: &str) -> PathBuf {
    runtime_dir().join(format!("permission-mcp-{:x}.json", chat_hash(chat_id)))
}

/// Where `--debug-file` writes when the UI asks for network-level logging.
fn debug_log_path(chat_id: &str) -> PathBuf {
    runtime_dir().join(format!("debug-{:x}.log", chat_hash(chat_id)))
}

/* ---------- shared types ---------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOptions {
    /// Frontend-owned identifier for the chat, and the event routing key.
    pub chat_id: String,
    pub cwd: String,
    /// Resume an existing transcript by session uuid.
    pub resume: Option<String>,
    pub model: Option<String>,
    /// `default` | `acceptEdits` | `bypassPermissions` | `plan`
    pub permission_mode: Option<String>,
    /// Extra raw CLI args, appended last.
    pub extra_args: Option<Vec<String>>,
    /// Spawn with `--debug-file` and tail it into `claude://debug` events.
    #[serde(default)]
    pub debug: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStatus {
    pub chat_id: String,
    /// Monotonic id for this spawn, so a late stop from a torn-down component
    /// is recognised as stale rather than killing its replacement.
    pub instance: u64,
    pub cwd: String,
    pub session_id: Option<String>,
    pub pid: Option<u32>,
    pub alive: bool,
    /// A turn is in flight.
    pub running: bool,
    /// True when `start` found a live process and attached instead of spawning.
    pub attached: bool,
    pub permission_mode: Option<String>,
    /// Prompts raised before the pane mounted, for it to render on arrival.
    #[serde(default)]
    pub pending_permissions: Vec<PermissionRequest>,
    /// Present once reaped. `Some(None)` means signalled rather than exited.
    #[serde(default)]
    pub exit_code: Option<Option<i32>>,
}

struct Chat {
    instance: u64,
    /// Label of the window that spawned this chat.
    ///
    /// Children live and die with the window, and with more than one window
    /// open that has to mean *this* window: nothing else can answer the
    /// permission prompts this chat raises, so leaving it running past its
    /// window's close would park the next ask on a pane that no longer exists.
    owner: String,
    cwd: String,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    session_id: Arc<Mutex<Option<String>>>,
    pid: u32,
    permission_mode: Option<String>,
    alive: Arc<AtomicBool>,
    /// Set (under the `child` mutex) once the reader thread has reaped the
    /// child. After that the pid may be recycled, so signalling it is unsafe.
    reaped: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    /// The entry outlives the process so a later send can say "exited with 1"
    /// rather than "no such chat", which reads as a routing bug.
    exit_code: Arc<Mutex<Option<Option<i32>>>>,
    /// First user prompt with text, held until the transcript exists and the
    /// session can be named from it.
    title_candidate: Arc<Mutex<Option<String>>>,
    /// Naming is settled: requested, or the transcript already had a title.
    titled: Arc<AtomicBool>,
}

impl Chat {
    fn status(&self, chat_id: &str, attached: bool, pending: Vec<PermissionRequest>) -> ChatStatus {
        ChatStatus {
            chat_id: chat_id.to_string(),
            instance: self.instance,
            cwd: self.cwd.clone(),
            session_id: self.session_id.lock().clone(),
            pid: Some(self.pid),
            alive: self.alive.load(Ordering::SeqCst),
            running: self.running.load(Ordering::SeqCst),
            attached,
            permission_mode: self.permission_mode.clone(),
            pending_permissions: pending,
            exit_code: *self.exit_code.lock(),
        }
    }
}

/* ---------- manager ---------- */

#[derive(Default)]
pub struct ChatManager {
    chats: Mutex<HashMap<String, Chat>>,
    /// Ids mid-spawn, so two concurrent starts cannot both spawn a child and
    /// have the second insert orphan the first one's process.
    spawning: Mutex<HashSet<String>>,
    next_instance: AtomicU64,
    app: Mutex<Option<AppHandle>>,
    permission: Mutex<Option<Arc<PermissionState>>>,
}

impl ChatManager {
    pub fn init(&self, app: AppHandle, permission: Arc<PermissionState>) {
        *self.app.lock() = Some(app);
        *self.permission.lock() = Some(permission);
    }

    fn emit(&self, event: &str, payload: Value) {
        if let Some(app) = self.app.lock().clone() {
            let _ = app.emit(event, payload);
        }
    }

    /// Kill every chat. Called on process exit, which is the whole point of
    /// this module owning them.
    pub fn kill_all(&self) {
        let ids: Vec<String> = self.chats.lock().keys().cloned().collect();
        for id in ids {
            self.kill(&id, None);
        }
    }

    /// Kill the chats one window started. Called when that window is destroyed.
    ///
    /// A chat another window has *attached* to still goes, because attaching
    /// shares one process rather than transferring it: the alternative is a
    /// chat whose owner is gone, which is exactly the orphan this module was
    /// written to rule out.
    pub fn kill_owned_by(&self, owner: &str) {
        let ids: Vec<String> = self
            .chats
            .lock()
            .iter()
            .filter(|(_, chat)| chat.owner == owner)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.kill(&id, None);
        }
    }

    /// Kill one chat. With `instance`, only if it still refers to that spawn.
    pub fn kill(&self, chat_id: &str, instance: Option<u64>) {
        let mut chats = self.chats.lock();
        if let Some(chat) = chats.get(chat_id) {
            if instance.is_some_and(|wanted| wanted != chat.instance) {
                return;
            }
        }
        let Some(chat) = chats.remove(chat_id) else {
            return;
        };
        drop(chats);
        // Pending prompts die with the chat: a bridge thread parked on one
        // would otherwise wait forever, and `pending_for` would hand the stale
        // ask to whatever chat next takes this id.
        if let Some(permission) = self.permission.lock().clone() {
            permission.cancel_for(chat_id);
        }
        let _ = std::fs::remove_file(mcp_config_path(chat_id));
        let _ = std::fs::remove_file(debug_log_path(chat_id));
        chat.alive.store(false, Ordering::SeqCst);
        // Signal the group so the CLI's own children go too, then make sure the
        // direct child is gone even if it had already left its group. Skipped
        // once the reader thread has reaped the child: its pid may already be
        // recycled, and killpg would then hit an unrelated process group. The
        // `reaped` flag flips under this same mutex, so the check cannot race
        // the reap.
        let mut child = chat.child.lock();
        if !chat.reaped.load(Ordering::SeqCst) {
            unsafe { libc::killpg(chat.pid as i32, libc::SIGTERM) };
            let _ = child.kill();
        }
        drop(child);
        // A turn dies with the process and nothing in the store would say so,
        // which left every reader showing the session live for as long as its
        // grace windows ran. Written after the signal, so the CLI is no longer
        // appending, and only for a turn that was actually in flight: a chat
        // killed between turns ended cleanly and should keep saying so.
        if chat.running.load(Ordering::SeqCst) {
            if let Some(session) = chat.session_id.lock().clone() {
                if let Some(path) = transcript_path(&session) {
                    crate::sessions::append_interrupt_marker(&path, &session);
                }
            }
        }
    }

    pub fn statuses(&self) -> Vec<ChatStatus> {
        self.chats
            .lock()
            .iter()
            .map(|(id, chat)| chat.status(id, false, Vec::new()))
            .collect()
    }

    /// Take a handle on one chat's stdin, releasing the map immediately.
    ///
    /// The write can park: a pasted screenshot is a base64 PNG well past the
    /// pipe buffer, and holding the map across that would block every other op.
    fn stdin_handle(&self, chat_id: &str) -> Result<Arc<Mutex<ChildStdin>>, String> {
        let chats = self.chats.lock();
        let chat = chats.get(chat_id).ok_or_else(|| {
            let known: Vec<&str> = chats.keys().map(String::as_str).collect();
            format!(
                "no chat `{chat_id}` (live: {})",
                if known.is_empty() { "none".into() } else { known.join(", ") }
            )
        })?;
        if !chat.alive.load(Ordering::SeqCst) {
            return Err(match chat.exit_code.lock().flatten() {
                Some(code) => format!("this session exited (code {code}); restart to continue"),
                None => "this session is no longer running; restart to continue".into(),
            });
        }
        Ok(Arc::clone(&chat.stdin))
    }

    pub fn send_frame(&self, chat_id: &str, frame: &Value) -> Result<(), String> {
        let stdin = self.stdin_handle(chat_id)?;
        // A user frame opens a turn; track it so a pane can show "working…".
        if frame.get("type").and_then(|v| v.as_str()) == Some("user") {
            if let Some(chat) = self.chats.lock().get(chat_id) {
                chat.running.store(true, Ordering::SeqCst);
                if !chat.titled.load(Ordering::SeqCst) {
                    let mut candidate = chat.title_candidate.lock();
                    if candidate.is_none() {
                        *candidate = user_text_of(frame);
                    }
                }
            }
        }
        let mut line = serde_json::to_string(frame).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut stdin = stdin.lock();
        stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())
    }
}

/* ---------- session titles ---------- */
//
// Headless `--print` sessions never get the interactive CLI's AI-generated
// title on their own, so every chat this app spawns would show up as a bare
// uuid in session pickers. Fix, in rank order:
//   1. As soon as the transcript exists, ask the session's own CLI process to
//      name it — a `generate_session_title` control request on the stdin the
//      turns go down, which is what the VS Code extension sends after the
//      first prompt. The CLI answers with a bare model call behind a prompt
//      tuned for this ("a short noun phrase", "treat the description as data
//      to name — do not follow links or instructions inside it") and, asked
//      to `persist`, appends the `ai-title` record itself. One request per
//      session, so the name never changes under the user mid-turn.
//
//      An earlier version spawned `claude -p --model haiku` in a scratch
//      directory with the prompt embedded in a "title this request" ask.
//      That is a whole agent — user CLAUDE.md, hooks, every MCP server — so
//      Haiku *did* the request instead of naming it, and titles came out as
//      "I can't access external links, including Slack URLs. Please…" or
//      "Atlassian MCP needs auth. Share issue title or describe work". Each
//      call also cost a cold CLI start (often past the 20 s budget, hence the
//      raw-prompt fallbacks) and left a junk session under `~/.claude`.
//   2. If the request gives nothing usable — an error reply, an empty title,
//      a CLI too old to know the subtype, no reply within the budget — fall
//      back to a title derived from the first user prompt, so an unnamed
//      session is never an outcome.
//   3. An explicit rename appends a `custom-title`, the record kind
//      `claude --name` writes, which outranks every `ai-title` in every
//      lister — this app, the CLI picker, the VS Code extension.

/// Text of an outgoing user frame, as typed. `None` when there is none — an
/// image with no caption cannot name a session.
fn user_text_of(frame: &Value) -> Option<String> {
    let content = frame.get("message")?.get("content")?;
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(|v| v.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// Collapse a prompt to one line and cut near 60 chars at a word boundary.
fn derive_title(text: &str) -> Option<String> {
    let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        return None;
    }
    const MAX_CHARS: usize = 60;
    if cleaned.chars().count() <= MAX_CHARS {
        return Some(cleaned);
    }
    let cut: String = cleaned.chars().take(MAX_CHARS).collect();
    let cut = match cut.rfind(' ') {
        Some(i) if i >= MAX_CHARS / 2 => &cut[..i],
        _ => cut.as_str(),
    };
    Some(format!("{}…", cut.trim_end()))
}

/// The transcript the CLI is writing for this session. Found by scanning the
/// project dirs: the cwd-to-dirname escaping is lossy, so the directory name
/// cannot be computed from `cwd` alone.
pub(crate) fn transcript_path(session_id: &str) -> Option<PathBuf> {
    let root = crate::sessions::projects_root()?;
    let name = format!("{session_id}.jsonl");
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let candidate = entry.path().join(&name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Whether the transcript already carries a title. Streamed a line at a time
/// rather than read whole: this runs on the stdout pump, where a stall stops
/// the chat, and resumed transcripts run to megabytes. Substring filter first,
/// then a parse of just the matching lines, because message content can quote
/// these markers.
fn has_title_record(path: &Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|l| l.contains("\"type\":\"custom-title\"") || l.contains("\"type\":\"ai-title\""))
        .filter_map(|l| serde_json::from_str::<Value>(&l).ok())
        .any(|v| {
            matches!(
                v.get("type").and_then(|t| t.as_str()),
                Some("custom-title") | Some("ai-title")
            )
        })
}

/// Append a title record, plus the `agent-name` the CLI pairs with it, as
/// whole lines. One appended write of whole lines is safe next to the CLI's
/// own appends; a reader that catches a torn line skips it and heals on the
/// next scan.
fn append_title_records(
    path: &Path,
    session_id: &str,
    kind: &str,
    field: &str,
    title: &str,
) -> bool {
    let mut lines = String::new();
    for (kind, field) in [(kind, field), ("agent-name", "agentName")] {
        lines.push_str(&json!({ "type": kind, field: title, "sessionId": session_id }).to_string());
        lines.push('\n');
    }
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(lines.as_bytes()))
        .is_ok()
}

enum TitleState {
    /// The transcript exists and carries no name — ours to name.
    Untitled,
    /// A title record is already there; a resumed session keeps its name.
    Named,
    /// No transcript yet; worth checking again on the next frame.
    Missing,
}

/// Whether this session still needs a name.
fn title_state(session_id: &str) -> TitleState {
    let Some(path) = transcript_path(session_id) else {
        return TitleState::Missing;
    };
    if has_title_record(&path) {
        TitleState::Named
    } else {
        TitleState::Untitled
    }
}

/// Scratch cwd for the background `claude -p` helper calls (search-term
/// expansion). Sessions spawned there are tooling, not conversations, so the
/// sidebar scan drops the whole group. The directory keeps its old name: the
/// title generator used to run here too, and its leftovers stay hidden only
/// while the path matches.
pub fn helper_dir() -> PathBuf {
    std::env::temp_dir().join("mangouste-titlegen")
}

/// Budget for the CLI's naming call. Past this the derived title is written
/// instead: a session showing a bare uuid while a slow answer is waited on is
/// worse than a plainer name that lands promptly.
const TITLE_TIMEOUT_MS: u64 = 20_000;

/// The naming request, shaped as the VS Code extension sends it. `persist`
/// has the CLI append the `ai-title` record itself, through the writer that
/// also carries the record across resumes; the reply is only there to say
/// whether a fallback is needed.
fn title_request_frame(request_id: &str, description: &str) -> Value {
    json!({
        "type": "control_request",
        "request_id": request_id,
        "request": {
            "subtype": "generate_session_title",
            "description": description,
            "persist": true,
        }
    })
}

/// What a frame says about the naming request.
#[derive(Debug, PartialEq)]
enum TitleReply {
    /// Not a reply to it — another request's, or not a control frame at all.
    Other,
    /// The CLI named the session and is writing the record.
    Named,
    /// It gave nothing: an error, or a description too short for its
    /// generator (under ten characters comes back as no title).
    Empty,
}

fn title_reply(frame: &Value, request_id: &str) -> TitleReply {
    if frame.get("type").and_then(|v| v.as_str()) != Some("control_response") {
        return TitleReply::Other;
    }
    // The envelope nests a second `response`: the outer one is the reply, the
    // inner one is the payload shaped for the request's subtype.
    let Some(envelope) = frame.get("response") else {
        return TitleReply::Other;
    };
    if envelope.get("request_id").and_then(|v| v.as_str()) != Some(request_id) {
        return TitleReply::Other;
    }
    let named = envelope.get("subtype").and_then(|v| v.as_str()) == Some("success")
        && envelope
            .get("response")
            .and_then(|r| r.get("title"))
            .and_then(|t| t.as_str())
            .is_some_and(|t| !t.trim().is_empty());
    if named {
        TitleReply::Named
    } else {
        TitleReply::Empty
    }
}

/// Write the prompt-derived title if the session is still unnamed.
///
/// The backstop behind the CLI's naming call: an empty reply, an error, and no
/// reply within the budget all land here. Re-checked rather than assumed — the
/// CLI's own title, or a rename, can have landed meanwhile and keeps precedence.
fn settle_title(session_id: &str, prompt: &str) {
    if !matches!(title_state(session_id), TitleState::Untitled) {
        return;
    }
    let Some(derived) = derive_title(prompt) else {
        return;
    };
    if let Some(path) = transcript_path(session_id) {
        let _ = append_title_records(&path, session_id, "ai-title", "aiTitle", &derived);
    }
}

/// Ask the session's CLI to name it, with the derived title as the fallback
/// once the budget runs out.
///
/// Called from the stdout pump, so the write is the only work done inline: a
/// control frame is a few hundred bytes, and the stdin mutex serialises it
/// against the turns the frontend sends. The wait happens on its own thread.
fn request_session_title(
    stdin: &Arc<Mutex<ChildStdin>>,
    request_id: &str,
    session_id: String,
    prompt: String,
) {
    let mut line = title_request_frame(request_id, &prompt).to_string();
    line.push('\n');
    let written = {
        let mut stdin = stdin.lock();
        stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.flush())
            .is_ok()
    };
    if !written {
        settle_title(&session_id, &prompt);
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(TITLE_TIMEOUT_MS));
        settle_title(&session_id, &prompt);
    });
}

/// Rename a session by appending a `custom-title` record — the record kind
/// `claude --name` writes, which outranks any AI title in every lister.
#[tauri::command]
pub fn rename_session(session_id: String, title: String) -> Result<(), String> {
    // Validated, not rewritten: the frontend pins the name it sent as an
    // optimistic override until a scan reports that exact string back, so a
    // `derive_title` pass here (whitespace collapsed, cut at 60 chars) would
    // never match and would shadow every later CLI `/rename` for good.
    let title = title.trim();
    if title.is_empty() {
        return Err("empty title".into());
    }
    let path = transcript_path(&session_id).ok_or("no transcript for this session")?;
    if append_title_records(&path, &session_id, "custom-title", "customTitle", title) {
        Ok(())
    } else {
        Err("could not write to the transcript".into())
    }
}

/* ---------- search term expansion ---------- */
//
// Last rung of the sidebar's search ladder. The first two rungs are literal:
// filter the scanned metadata, then grep inside the transcripts. Both fail on
// the same class of query — the one where you remember the problem but not the
// words ("that session where auth kept 401ing"). Haiku turns that into the words
// somebody would actually have typed, and the literal grep runs again over them.
//
// An expansion, never an answer: the model never sees a transcript and never
// decides what matches. It only proposes terms, which keeps this cheap (one
// small call, no corpus in the prompt) and keeps the result explainable — every
// hit still comes with the line that matched it.

/// Terms accepted from one expansion. Enough to cover the synonyms of a short
/// query; past this the OR-match starts returning most of the corpus.
const MAX_EXPANDED_TERMS: usize = 8;

/// How long the expansion may take before it is abandoned and the child killed.
/// A search box cannot wait on a rate-limited CLI.
const EXPAND_TIMEOUT_MS: u64 = 20_000;

/// Ask Haiku for words likely to appear in the transcript being looked for.
///
/// Returns an empty vec rather than an error when the model gives nothing
/// usable: the caller's fallback is the literal search it already ran, so "no
/// expansion" is a normal outcome, not a failure worth surfacing.
#[tauri::command(async)]
pub fn expand_search_terms(query: String) -> Result<Vec<String>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let dir = helper_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ask = format!(
        "Someone is searching their Claude Code session transcripts and cannot \
         remember the exact wording. Their query: \"{query}\"\n\n\
         List up to {MAX_EXPANDED_TERMS} short search terms — single words or \
         two-word phrases — that would plausibly appear verbatim in the \
         conversation they are looking for. Include obvious synonyms, the \
         concrete technical nouns implied by the query, and likely error or \
         command strings. One term per line, nothing else."
    );
    let mut child = crate::env::with_child_path(&mut Command::new(claude_binary()))
        .args(["-p", "--model", "haiku"])
        .env("CLAUDE_CODE_ENTRYPOINT", ENTRYPOINT_SEARCH)
        .arg(&ask)
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not run claude: {e}"))?;

    // `output()` would block forever on a hung child, and this is on a
    // keystroke-driven path, so the wait is polled and the child is killed if it
    // outstays the budget.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(EXPAND_TIMEOUT_MS);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("term expansion timed out".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("claude exited with an error".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut terms: Vec<String> = Vec::new();
    for line in text.lines() {
        // Models reach for bullets and numbering however firmly they are told
        // not to, and a stray `-` or `1.` in a term makes it match nothing.
        let cleaned = line
            .trim()
            .trim_start_matches(['-', '*', '•', '·'])
            .trim_start_matches(|c: char| c.is_ascii_digit())
            .trim_start_matches(['.', ')', ':'])
            .trim()
            .trim_matches('"')
            .trim()
            .to_string();
        if cleaned.is_empty() || cleaned.len() > 60 || cleaned.split_whitespace().count() > 3 {
            continue;
        }
        if !terms.iter().any(|t| t.eq_ignore_ascii_case(&cleaned)) {
            terms.push(cleaned);
        }
        if terms.len() >= MAX_EXPANDED_TERMS {
            break;
        }
    }
    Ok(terms)
}

#[cfg(test)]
mod expand_tests {
    use super::*;

    /// Calls the real CLI, so it spends a few Haiku tokens and needs a working
    /// login. Ignored by default:
    /// `cargo test expands_a_vague_query -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn expands_a_vague_query() {
        let terms = expand_search_terms("the session where auth kept 401ing".into());
        eprintln!("{terms:?}");
        let terms = terms.expect("an expansion");
        assert!(!terms.is_empty());
        assert!(terms.iter().all(|t| !t.is_empty() && t.len() <= 60));
    }
}

/* ---------- tool liveness probe ---------- */
//
// stream-json emits nothing between `tool_use` and `tool_result`, so a long
// Bash call is indistinguishable from a hang. But each child gets its own
// process group at spawn, so /proc can say what is actually executing under
// it. While a turn is running, any group member that was not there before the
// turn started is tool work; the newest such process is the one worth naming.

struct GroupProc {
    pid: u32,
    /// Ordering key only: higher means more recently started. On Linux this is
    /// the kernel start time in ticks since boot; elsewhere it is derived from
    /// elapsed time, so the values are comparable within a scan but not across
    /// platforms and not meaningful on their own.
    rank: u64,
    zombie: bool,
}

/// Every process in `pgid`'s group except the CLI itself.
#[cfg(target_os = "linux")]
fn group_processes(pgid: u32) -> Vec<GroupProc> {
    let mut procs = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return procs;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        if pid == pgid {
            continue;
        }
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        // comm may contain spaces or parens; fields resume after the last ')'.
        let Some(rest) = stat.rfind(')').map(|i| &stat[i + 1..]) else {
            continue;
        };
        let fields: Vec<&str> = rest.split_whitespace().collect();
        // After comm: [0] state, [1] ppid, [2] pgrp, ..., [19] starttime.
        if fields.len() < 20 || fields[2].parse() != Ok(pgid) {
            continue;
        }
        procs.push(GroupProc {
            pid,
            rank: fields[19].parse().unwrap_or(0),
            zombie: fields[0] == "Z",
        });
    }
    procs
}

/// `ps` stands in for `/proc`, which only Linux has.
///
/// One sweep of the whole table per call rather than a query per pid: the group
/// is small but unknown, and `ps` cannot filter on pgid directly.
#[cfg(not(target_os = "linux"))]
fn group_processes(pgid: u32) -> Vec<GroupProc> {
    let mut procs = Vec::new();
    let Ok(output) = Command::new("ps").args(["-Ao", "pid=,pgid=,state=,etime="]).output() else {
        return procs;
    };
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 4 {
            continue;
        }
        let Ok(pid) = fields[0].parse::<u32>() else {
            continue;
        };
        if pid == pgid || fields[1].parse() != Ok(pgid) {
            continue;
        }
        procs.push(GroupProc {
            pid,
            // `ps` offers elapsed time, not a boot-relative start, so invert it
            // to keep the Linux ordering: larger rank means started later.
            rank: u64::MAX - parse_etime(fields[3]),
            // macOS decorates state with flags like `Z+`, so match the prefix.
            zombie: fields[2].starts_with('Z'),
        });
    }
    procs
}

/// Parse a `ps -o etime` value (`[[dd-]hh:]mm:ss`) into seconds.
///
/// Only `group_processes` off Linux calls this, but it stays compiled
/// everywhere so its tests run on any host.
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn parse_etime(raw: &str) -> u64 {
    let (days, rest) = match raw.split_once('-') {
        Some((days, rest)) => (days.parse::<u64>().unwrap_or(0), rest),
        None => (0, raw),
    };
    let seconds = rest
        .split(':')
        .fold(0u64, |acc, part| acc * 60 + part.parse::<u64>().unwrap_or(0));
    days * 86_400 + seconds
}

/// One display line for a pid, from its argv. None for anything already gone,
/// for empty cmdlines, and for our own permission-prompt server — which is a
/// group member for the whole session but never what the user is waiting on.
#[cfg(target_os = "linux")]
fn command_line_of(pid: u32) -> Option<String> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let joined = raw
        .split(|b| *b == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect::<Vec<_>>()
        .join(" ");
    shape_command(&joined)
}

/// Same line from `ps`, which already joins argv with spaces.
#[cfg(not(target_os = "linux"))]
fn command_line_of(pid: u32) -> Option<String> {
    // `-ww`: BSD `ps` truncates each line to the terminal width, and with no
    // terminal it truncates to 80 columns — which is well inside the length of
    // the `node .../claude ...` lines this exists to show.
    let output = Command::new("ps")
        .args(["-ww", "-o", "args=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    shape_command(&String::from_utf8_lossy(&output.stdout))
}

/// Collapse whitespace, drop what should never be shown, and cap the length.
fn shape_command(raw: &str) -> Option<String> {
    let flat = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() || flat.contains("--permission-server") {
        return None;
    }
    const MAX_CHARS: usize = 160;
    if flat.chars().count() > MAX_CHARS {
        let cut: String = flat.chars().take(MAX_CHARS).collect();
        return Some(format!("{cut}…"));
    }
    Some(flat)
}

/// Client tags handed to the CLI as `CLAUDE_CODE_ENTRYPOINT`.
///
/// Left unset the CLI infers `sdk-cli` from `--print`, so every human-driven
/// mangouste turn lands in the automation bucket of usage dashboards, sat next
/// to cron jobs — the VS Code extension avoids that by identifying itself the
/// same way. The helper tag stays distinct on purpose: nobody is watching those
/// calls, and folding them into the interactive figure would only move the
/// distortion somewhere less visible. (Session naming carries no tag of its
/// own any more: it is a request on the chat's own process, billed with it,
/// as the extension's is.)
const ENTRYPOINT_CHAT: &str = "mangouste";
const ENTRYPOINT_SEARCH: &str = "mangouste-search";

/// The chat tag, overridable for dashboards that only bucket the values the CLI
/// emits on its own and would file an unknown tag as automation regardless.
fn chat_entrypoint() -> String {
    match std::env::var("MANGOUSTE_ENTRYPOINT") {
        Ok(explicit) if !explicit.is_empty() => explicit,
        _ => ENTRYPOINT_CHAT.to_string(),
    }
}

/// The `claude` to run.
///
/// An absolute path rather than a bare name wherever one can be found: the last
/// resort leans on the child's PATH, and on a windowed macOS launch that PATH is
/// `/usr/bin:/bin:/usr/sbin:/sbin` — see `crate::env`.
///
/// `child_path_dirs` leads because it is what the word `claude` means in the
/// user's own terminal, which is the CLI they authenticated. It is empty off
/// macOS, so the order below is unchanged there.
fn claude_binary() -> String {
    if let Ok(explicit) = std::env::var("MANGOUSTE_CLAUDE_BIN") {
        if !explicit.is_empty() {
            return explicit;
        }
    }
    for dir in crate::env::child_path_dirs() {
        let candidate = dir.join("claude");
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    if let Some(home) = dirs::home_dir() {
        for candidate in [
            home.join(".local/bin/claude"),
            home.join(".claude/local/claude"),
            home.join(".bun/bin/claude"),
            home.join(".volta/bin/claude"),
        ] {
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    // `/opt/homebrew` is Apple Silicon's Homebrew prefix and is on no default
    // PATH; `/usr/local` is Intel's, and also where a plain `npm -g` lands.
    for candidate in [
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        "/usr/bin/claude",
    ] {
        if std::path::Path::new(candidate).is_file() {
            return candidate.to_string();
        }
    }
    "claude".to_string()
}

/// Point the CLI at our own binary as its permission prompt tool.
///
/// Deliberately NOT combined with `--strict-mcp-config`: that would drop the
/// user's own configured servers, and those are exactly the tools the prompt
/// exists to approve.
fn write_permission_mcp_config(socket: &str, chat_id: &str) -> Option<PathBuf> {
    let exe = own_exe()?;
    let config = json!({
        "mcpServers": {
            "mangouste": {
                "command": exe.to_string_lossy(),
                "args": ["--permission-server", socket, "--permission-chat", chat_id],
            }
        }
    });
    let path = mcp_config_path(chat_id);
    std::fs::create_dir_all(path.parent()?).ok()?;
    std::fs::write(&path, config.to_string()).ok()?;
    Some(path)
}

/// Our own binary, as a path the CLI can actually spawn.
///
/// `current_exe` reads `/proc/self/exe`, which Linux renders as
/// `<path> (deleted)` once the running binary has been replaced — i.e. after any
/// reinstall or `cargo build` while the app is open. Spawning that literal path
/// fails with ENOENT, the permission server never connects, and because the CLI
/// was still told `--permission-prompt-tool mcp__mangouste__approve` every gated
/// tool call came back as "MCP tool ... not found" instead of a prompt. So the
/// marker is stripped and the result checked: no usable path means no prompt
/// tool flag at all, which is degraded but not broken.
fn own_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    if exe.is_file() {
        return Some(exe);
    }
    // Replaced under us: the same path on disk is the new build.
    let raw = exe.to_string_lossy();
    let live = PathBuf::from(raw.strip_suffix(" (deleted)")?);
    if live.is_file() {
        return Some(live);
    }
    eprintln!("mangouste: own binary is gone ({raw}); tool permission prompts are disabled until restart");
    None
}

fn build_args(
    options: &StartOptions,
    permission_config: Option<&std::path::Path>,
) -> Vec<String> {
    let mut args = vec![
        "--print".into(),
        "--verbose".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--output-format".into(),
        "stream-json".into(),
        // Without this the UI gets nothing until a whole assistant message
        // settles — long thinking reads as a hang.
        "--include-partial-messages".into(),
    ];
    if let Some(resume) = &options.resume {
        args.push("--resume".into());
        args.push(resume.clone());
    }
    if let Some(model) = &options.model {
        args.push("--model".into());
        args.push(model.clone());
    }
    if let Some(mode) = &options.permission_mode {
        args.push("--permission-mode".into());
        args.push(mode.clone());
    }
    // Without a prompt tool the CLI cannot ask, so anything with no matching
    // rule is silently denied — the model just sees "you haven't granted it yet".
    if let Some(config) = permission_config {
        args.push("--mcp-config".into());
        args.push(config.to_string_lossy().into_owned());
        args.push("--permission-prompt-tool".into());
        args.push("mcp__mangouste__approve".into());
    }
    if options.debug {
        args.push("--debug-file".into());
        args.push(debug_log_path(&options.chat_id).to_string_lossy().into_owned());
    }
    if let Some(extra) = &options.extra_args {
        args.extend(extra.iter().cloned());
    }
    args
}

/// Releases a `ChatManager::spawning` reservation on every exit path.
struct SpawnReservation<'a> {
    manager: &'a ChatManager,
    id: String,
}

impl Drop for SpawnReservation<'_> {
    fn drop(&mut self) {
        self.manager.spawning.lock().remove(&self.id);
    }
}

/// Start a chat, or attach to the one already running that id.
pub fn start(
    manager: &Arc<ChatManager>,
    owner: &str,
    options: StartOptions,
) -> Result<ChatStatus, String> {
    // Reserve the id before the liveness check: two concurrent starts would
    // otherwise both find nothing live and both spawn, and the loser's insert
    // would drop the winner's Chat, orphaning its process.
    if !manager.spawning.lock().insert(options.chat_id.clone()) {
        return Err(format!("chat `{}` is already starting", options.chat_id));
    }
    let _reservation = SpawnReservation { manager, id: options.chat_id.clone() };
    {
        let chats = manager.chats.lock();
        if let Some(chat) = chats.get(&options.chat_id) {
            if chat.alive.load(Ordering::SeqCst) {
                let pending = manager
                    .permission
                    .lock()
                    .as_ref()
                    .map(|p| p.pending_for(&options.chat_id))
                    .unwrap_or_default();
                return Ok(chat.status(&options.chat_id, true, pending));
            }
        }
    }
    // Not live: clear any dead entry before spawning over it.
    manager.kill(&options.chat_id, None);

    let instance = manager.next_instance.fetch_add(1, Ordering::SeqCst) + 1;
    let permission_config = manager
        .permission
        .lock()
        .as_ref()
        .and_then(|p| p.socket_path())
        .and_then(|socket| write_permission_mcp_config(&socket, &options.chat_id));

    // Truncate any previous run's debug log so the tail never replays it.
    if options.debug {
        let _ = std::fs::write(debug_log_path(&options.chat_id), "");
    }

    let mut command = Command::new(claude_binary());
    crate::env::with_child_path(&mut command);
    command
        .args(build_args(&options, permission_config.as_deref()))
        .env("CLAUDE_CODE_ENTRYPOINT", chat_entrypoint())
        .current_dir(&options.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to spawn claude: {e}"))?;

    let pid = child.id();
    let stdout = child.stdout.take().ok_or("no stdout on claude process")?;
    let stderr = child.stderr.take().ok_or("no stderr on claude process")?;
    let stdin = child.stdin.take().ok_or("no stdin on claude process")?;

    let child = Arc::new(Mutex::new(child));
    let session_id = Arc::new(Mutex::new(None::<String>));
    let alive = Arc::new(AtomicBool::new(true));
    let reaped = Arc::new(AtomicBool::new(false));
    let running = Arc::new(AtomicBool::new(false));
    let exit_code = Arc::new(Mutex::new(None));
    let title_candidate = Arc::new(Mutex::new(None::<String>));
    let titled = Arc::new(AtomicBool::new(false));
    let stdin = Arc::new(Mutex::new(stdin));
    // Unique on this process's stream, which is all a control request id has
    // to be; the frontend's own ids are `mangouste-<n>-<ms>`.
    let title_request_id = format!("mangouste-title-{instance}");

    // stdout: one JSON object per line, forwarded verbatim.
    {
        let manager = Arc::clone(manager);
        let chat_id = options.chat_id.clone();
        let child = Arc::clone(&child);
        let session_id = Arc::clone(&session_id);
        let alive = Arc::clone(&alive);
        let reaped = Arc::clone(&reaped);
        let running = Arc::clone(&running);
        let exit_code = Arc::clone(&exit_code);
        let title_candidate = Arc::clone(&title_candidate);
        let titled = Arc::clone(&titled);
        let stdin = Arc::clone(&stdin);
        let title_request_id = title_request_id.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            // Bytes, not `lines()`: that iterator ends on the first non-UTF-8
            // byte, and this thread is the pipe's only reader — the child would
            // then block on its next write while `alive` still reports the chat
            // as accepting input.
            let mut buf = Vec::new();
            loop {
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(_) => {
                        // A pipe error rather than EOF: nothing will drain
                        // stdout again, so signal the child instead of falling
                        // into a reap poll that a blocked write would never
                        // let finish. `reaped` is only set after this loop, so
                        // the pid is still ours to signal.
                        unsafe { libc::killpg(pid as i32, libc::SIGTERM) };
                        let mut guard = child.lock();
                        let _ = guard.kill();
                        break;
                    }
                }
                let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                buf.clear();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(&line) {
                    Ok(value) => {
                        if let Some(id) = value.get("session_id").and_then(|v| v.as_str()) {
                            let mut slot = session_id.lock();
                            if slot.as_deref() != Some(id) {
                                *slot = Some(id.to_string());
                            }
                        }
                        // Start naming the session the moment it can be
                        // named: the transcript appears just after the first
                        // user frame, and waiting for the turn to end left
                        // long first turns showing a bare uuid the whole time.
                        if !titled.load(Ordering::SeqCst) {
                            let candidate = title_candidate.lock().clone();
                            let session = session_id.lock().clone();
                            if let (Some(prompt), Some(sid)) = (candidate, session) {
                                match title_state(&sid) {
                                    TitleState::Untitled => {
                                        titled.store(true, Ordering::SeqCst);
                                        request_session_title(&stdin, &title_request_id, sid, prompt);
                                    }
                                    TitleState::Named => titled.store(true, Ordering::SeqCst),
                                    TitleState::Missing => {}
                                }
                            }
                        } else if title_reply(&value, &title_request_id) == TitleReply::Empty {
                            // The CLI declined to name it, so the derived title
                            // goes in now rather than when the budget runs out.
                            // The frame still goes to the frontend below: the
                            // control channel there swallows ids it did not
                            // issue, so nothing renders.
                            let candidate = title_candidate.lock().clone();
                            let session = session_id.lock().clone();
                            if let (Some(prompt), Some(sid)) = (candidate, session) {
                                settle_title(&sid, &prompt);
                            }
                        }
                        if value.get("type").and_then(|v| v.as_str()) == Some("result") {
                            running.store(false, Ordering::SeqCst);
                        }
                        manager.emit(
                            EVENT_MESSAGE,
                            json!({ "chatId": chat_id, "instance": instance, "payload": value }),
                        );
                    }
                    Err(_) => {
                        // Non-JSON on stdout is a CLI-level message, not a frame.
                        manager.emit(
                            EVENT_STDERR,
                            json!({ "chatId": chat_id, "instance": instance, "line": line }),
                        );
                    }
                }
            }
            // Reap without holding the mutex across a blocking wait(): `kill`
            // and the exit handler need this lock, and wait() can take
            // arbitrarily long. try_wait is instant, so a poll loop keeps the
            // lock uncontended; `reaped` flips under the same lock so `kill`
            // can never signal a recycled pid.
            let code = loop {
                let mut guard = child.lock();
                match guard.try_wait() {
                    Ok(Some(status)) => {
                        reaped.store(true, Ordering::SeqCst);
                        break status.code();
                    }
                    Ok(None) => {}
                    Err(_) => break None,
                }
                drop(guard);
                std::thread::sleep(std::time::Duration::from_millis(50));
            };
            alive.store(false, Ordering::SeqCst);
            running.store(false, Ordering::SeqCst);
            *exit_code.lock() = Some(code);
            manager.emit(
                EVENT_EXIT,
                json!({ "chatId": chat_id, "instance": instance, "code": code }),
            );
        });
    }

    // stderr: surfaced separately so spawn failures are visible in the UI.
    {
        let manager = Arc::clone(manager);
        let chat_id = options.chat_id.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            // Bytes for the same reason as stdout, and more pressingly here:
            // hooks and MCP servers inherit this pipe and can write raw bytes
            // to it, and a stderr nobody drains wedges the child mid-write.
            let mut buf = Vec::new();
            while reader.read_until(b'\n', &mut buf).unwrap_or(0) > 0 {
                let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                buf.clear();
                manager.emit(
                    EVENT_STDERR,
                    json!({ "chatId": chat_id, "instance": instance, "line": line }),
                );
            }
        });
    }

    // Tool liveness: name what is actually executing while a turn is running.
    // The baseline is refreshed on every idle tick, so session-lifetime helpers
    // (MCP servers, the permission bridge) accumulate into it and only work
    // started during the turn is ever reported.
    {
        let manager = Arc::clone(manager);
        let chat_id = options.chat_id.clone();
        let alive = Arc::clone(&alive);
        let running = Arc::clone(&running);
        std::thread::spawn(move || {
            let mut baseline: HashSet<u32> = HashSet::new();
            let mut last: Option<String> = None;
            while alive.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(1000));
                if !running.load(Ordering::SeqCst) {
                    baseline = group_processes(pid).iter().map(|p| p.pid).collect();
                    if last.take().is_some() {
                        manager.emit(
                            EVENT_TOOL_ACTIVITY,
                            json!({ "chatId": chat_id, "instance": instance, "command": null }),
                        );
                    }
                    continue;
                }
                let procs = group_processes(pid);
                let mut fresh: Vec<&GroupProc> = procs
                    .iter()
                    .filter(|p| !p.zombie && !baseline.contains(&p.pid))
                    .collect();
                fresh.sort_by(|a, b| b.rank.cmp(&a.rank));
                let command = fresh.iter().find_map(|p| command_line_of(p.pid));
                if command != last {
                    manager.emit(
                        EVENT_TOOL_ACTIVITY,
                        json!({ "chatId": chat_id, "instance": instance, "command": command }),
                    );
                    last = command;
                }
            }
        });
    }

    // Network-level debug: tail the CLI's `--debug-file` into events. Polling
    // rather than inotify — the file may not exist yet when this thread starts,
    // and 300ms is plenty for a log meant for human eyes.
    if options.debug {
        use std::io::{Read, Seek, SeekFrom};
        let manager = Arc::clone(manager);
        let chat_id = options.chat_id.clone();
        let alive = Arc::clone(&alive);
        let path = debug_log_path(&options.chat_id);
        std::thread::spawn(move || {
            let mut offset: u64 = 0;
            // Partial trailing line, kept as bytes until its newline arrives:
            // a multi-byte char can straddle two ticks, and lossy-decoding
            // each chunk on its own would mangle it into replacement chars.
            let mut carry: Vec<u8> = Vec::new();
            while alive.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(300));
                let Ok(mut file) = std::fs::File::open(&path) else {
                    continue;
                };
                let len = file.metadata().map(|m| m.len()).unwrap_or(0);
                if len <= offset {
                    continue;
                }
                if file.seek(SeekFrom::Start(offset)).is_err() {
                    continue;
                }
                let mut chunk = Vec::new();
                if file.read_to_end(&mut chunk).is_err() {
                    continue;
                }
                // Advance by what was read, not to `len`: the CLI can append
                // between the metadata call and the read, and `read_to_end`
                // consumes past `len` — so resetting the cursor to it re-emitted
                // everything after `len` on the next tick.
                offset += chunk.len() as u64;
                carry.extend_from_slice(&chunk);
                while let Some(newline) = carry.iter().position(|b| *b == b'\n') {
                    let line = String::from_utf8_lossy(&carry[..newline]).trim_end().to_string();
                    carry.drain(..=newline);
                    if !line.is_empty() {
                        manager.emit(
                            EVENT_DEBUG,
                            json!({ "chatId": chat_id, "instance": instance, "line": line }),
                        );
                    }
                }
            }
        });
    }

    let chat = Chat {
        instance,
        owner: owner.to_string(),
        cwd: options.cwd.clone(),
        child,
        stdin,
        session_id,
        pid,
        permission_mode: options.permission_mode.clone(),
        alive,
        reaped,
        running,
        exit_code,
        title_candidate,
        titled,
    };
    let status = chat.status(&options.chat_id, false, Vec::new());
    manager.chats.lock().insert(options.chat_id.clone(), chat);
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> StartOptions {
        StartOptions {
            chat_id: "c1".into(),
            cwd: "/home/user/workspace/demo".into(),
            resume: None,
            model: None,
            permission_mode: None,
            extra_args: None,
            debug: false,
        }
    }

    #[test]
    fn etime_parses_every_ps_shape() {
        assert_eq!(parse_etime("05"), 5);
        assert_eq!(parse_etime("12:34"), 12 * 60 + 34);
        assert_eq!(parse_etime("01:02:03"), 3_600 + 2 * 60 + 3);
        assert_eq!(parse_etime("2-03:04:05"), 2 * 86_400 + 3 * 3_600 + 4 * 60 + 5);
    }

    #[test]
    fn etime_shape_it_cannot_read_sorts_as_newest() {
        // Garbage yields 0 elapsed, so `u64::MAX - 0` ranks it first. Better to
        // surface an unparsed process than to hide it behind older ones.
        assert_eq!(parse_etime(""), 0);
        assert_eq!(parse_etime("what"), 0);
    }

    #[test]
    fn shape_command_collapses_and_caps() {
        assert_eq!(shape_command("  git   status  ").as_deref(), Some("git status"));
        assert_eq!(shape_command("   "), None);
        assert_eq!(shape_command("claude --permission-server /tmp/s"), None);
        let long = "x".repeat(200);
        let shaped = shape_command(&long).expect("shaped");
        assert_eq!(shaped.chars().count(), 161);
        assert!(shaped.ends_with('…'));
    }

    #[test]
    fn user_extra_args_still_land_last() {
        let mut options = options();
        options.extra_args = Some(vec!["--fallback-model".into(), "haiku".into()]);
        let args = build_args(&options, None);
        assert_eq!(args.last().map(String::as_str), Some("haiku"));
    }

    #[test]
    fn title_request_is_the_extensions() {
        let frame = title_request_frame("mangouste-title-7", "fix the sidebar");
        assert_eq!(frame["type"], "control_request");
        assert_eq!(frame["request_id"], "mangouste-title-7");
        assert_eq!(frame["request"]["subtype"], "generate_session_title");
        assert_eq!(frame["request"]["description"], "fix the sidebar");
        assert_eq!(frame["request"]["persist"], true);
    }

    #[test]
    fn title_reply_reads_only_its_own_response() {
        let ours = |inner: Value| {
            json!({
                "type": "control_response",
                "response": { "subtype": "success", "request_id": "t1", "response": inner }
            })
        };
        assert_eq!(title_reply(&ours(json!({ "title": "Sidebar reorder" })), "t1"), TitleReply::Named);
        // Under ten characters the CLI's generator answers with no title.
        assert_eq!(title_reply(&ours(json!({ "title": null })), "t1"), TitleReply::Empty);
        assert_eq!(title_reply(&ours(json!({ "title": "  " })), "t1"), TitleReply::Empty);
        assert_eq!(title_reply(&ours(json!({ "title": "x" })), "t2"), TitleReply::Other);
        let error = json!({
            "type": "control_response",
            "response": { "subtype": "error", "request_id": "t1", "error": "unknown subtype" }
        });
        assert_eq!(title_reply(&error, "t1"), TitleReply::Empty);
        assert_eq!(title_reply(&json!({ "type": "assistant" }), "t1"), TitleReply::Other);
    }

    #[test]
    fn user_text_keeps_the_prompt_as_typed() {
        let frame = json!({ "type": "user", "message": { "role": "user", "content": [
            { "type": "image", "source": {} },
            { "type": "text", "text": "  why does   this\nfail?  " }
        ] } });
        assert_eq!(user_text_of(&frame).as_deref(), Some("why does   this\nfail?"));
        let image_only = json!({ "type": "user", "message": { "role": "user", "content": [
            { "type": "image", "source": {} }
        ] } });
        assert_eq!(user_text_of(&image_only), None);
        let plain = json!({ "type": "user", "message": { "role": "user", "content": "hello" } });
        assert_eq!(user_text_of(&plain).as_deref(), Some("hello"));
    }

    #[test]
    fn derived_title_collapses_and_cuts_at_a_word() {
        assert_eq!(derive_title("  fix   the\nsidebar ").as_deref(), Some("fix the sidebar"));
        let long = "word ".repeat(30);
        let title = derive_title(&long).expect("a title");
        assert!(title.chars().count() <= 61, "{title}");
        assert!(title.ends_with('…'));
        assert_eq!(derive_title("   "), None);
    }
}
