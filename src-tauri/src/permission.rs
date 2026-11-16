//! Interactive tool-permission prompts.
//!
//! Claude Code has no way to ask a headless client for permission over
//! stream-json: with no rule and no prompt tool it just denies, which is why an
//! un-allowlisted MCP tool came back as "Claude requested permissions … but you
//! haven't granted it yet" with nothing shown to the user.
//!
//! The supported mechanism is `--permission-prompt-tool`, which names an MCP
//! tool the CLI calls to ask. So this module is two halves:
//!
//!   * a tiny stdio MCP server, run as `mangouste --permission-server`, which the
//!     CLI spawns and calls;
//!   * a unix-socket bridge back into the process that owns the chat, so the ask
//!     reaches a UI and the server blocks until someone answers.
//!
//! Keeping the server in our own binary avoids shipping a sidecar.
//!
//! The bridge lives in the **daemon**, not the window. It used to be scoped to
//! the GUI's pid, which meant the socket path baked into a child's `--mcp-config`
//! went stale the moment the window restarted, and every detached session's tool
//! prompt had nowhere to go. The daemon owns the pending map instead and fans
//! asks out to whichever windows are attached — with none attached, the ask
//! simply waits, which is what a session parked in `awaiting` should do.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::control::{read_request_line, RequestError};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

pub const EVENT_REQUEST: &str = "permission://request";
/// An ask the CLI stopped waiting on, carrying its request id.
pub const EVENT_WITHDRAWN: &str = "permission://withdrawn";

/// How long an ask must stay open before the session rail calls it `awaiting`.
///
/// A tool on the pane's "always allow" list is answered by the window within
/// milliseconds of the ask landing. Counting those would flash the row and fire
/// an `awaiting` notification for a prompt nobody was ever shown.
pub const AWAITING_SETTLE: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub id: String,
    /// Which chat is asking.
    ///
    /// The MCP server has no way to know this on its own, so each child gets its
    /// own `--mcp-config` naming its chat id on the server's command line. Before
    /// that, the frontend guessed by claiming any ask while it had a turn in
    /// flight — which is only ever right when exactly one chat is live.
    pub chat_id: Option<String>,
    pub tool_name: String,
    pub tool_use_id: Option<String>,
    pub input: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecision {
    pub id: String,
    /// `allow` or `deny`.
    pub behavior: String,
    /// Shown to the model when denying, so it can adapt rather than retry blind.
    pub message: Option<String>,
    /// Optional edited arguments, honoured by the CLI on allow.
    pub updated_input: Option<serde_json::Value>,
}

/// An open ask, the channel its answer goes back on, and when it landed.
type Pending = (PermissionRequest, Sender<PermissionDecision>, Instant);

#[derive(Default)]
pub struct PermissionState {
    /// The ask is kept next to its channel so a window that attaches later can
    /// be handed prompts raised while nothing was watching.
    /// The `Instant` is when the ask landed, for `AWAITING_SETTLE`.
    pending: Mutex<HashMap<String, Pending>>,
    socket_path: Mutex<Option<String>>,
}

impl PermissionState {
    pub fn socket_path(&self) -> Option<String> {
        self.socket_path.lock().clone()
    }

    /// Answer a pending prompt. The waiting bridge thread unblocks and replies
    /// to the MCP server, which returns the verdict to the CLI.
    pub fn respond(&self, decision: PermissionDecision) -> Result<(), String> {
        // Removed here rather than by the bridge thread once it wakes, so the
        // rail rescan the caller triggers after answering already sees the
        // session unblocked. The bridge's own removal is then a no-op, and so is
        // the hangup watcher's: an answered ask is gone from `pending`.
        let (_, sender, _) = self
            .pending
            .lock()
            .remove(&decision.id)
            .ok_or("no such pending permission request")?;
        sender.send(decision).map_err(|e| e.to_string())
    }

    /// The chat a pending ask belongs to, if the ask is still pending.
    pub fn chat_of(&self, id: &str) -> Option<String> {
        self.pending
            .lock()
            .get(id)
            .and_then(|(request, _, _)| request.chat_id.clone())
    }

    /// Chats with an ask that has been open for at least `AWAITING_SETTLE`.
    ///
    /// A permission prompt never reaches the transcript: the tool call it gates
    /// sits there unanswered, which reads exactly like a tool still running. So
    /// the session scan asks this instead, or a session blocked on you shows as
    /// `active` for as long as you leave it.
    pub fn awaiting_chats(&self) -> HashSet<String> {
        self.pending
            .lock()
            .values()
            .filter(|(_, _, asked_at)| asked_at.elapsed() >= AWAITING_SETTLE)
            .filter_map(|(request, _, _)| request.chat_id.clone())
            .collect()
    }

    /// Deny and drop every pending ask for one chat.
    ///
    /// Called when the chat is killed: its bridge threads would otherwise park
    /// on `recv()` forever, and the stale asks would be handed to whatever
    /// chat next takes the id.
    pub fn cancel_for(&self, chat_id: &str) {
        let cancelled: Vec<(String, Sender<PermissionDecision>)> = {
            let mut pending = self.pending.lock();
            let ids: Vec<String> = pending
                .iter()
                .filter(|(_, (request, _, _))| request.chat_id.as_deref() == Some(chat_id))
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| pending.remove(&id).map(|(_, sender, _)| (id, sender)))
                .collect()
        };
        for (id, sender) in cancelled {
            let _ = sender.send(PermissionDecision {
                id,
                behavior: "deny".into(),
                message: Some("the chat was killed before this was answered".into()),
                updated_input: None,
            });
        }
    }

    /// Drop the asks whose tool call the CLI has already answered for itself.
    ///
    /// `tool_use_ids` are the calls a chat's stream just carried results for.
    /// A result for a call that is still gated here means the CLI stopped
    /// waiting without saying so, and nothing else would ever notice: the
    /// hangup watcher only fires when the server is told. The ask then sits in
    /// `pending` for the life of the chat, the rail pins the session at
    /// `awaiting` while it works, and the card stays up for a question nothing
    /// is waiting on.
    ///
    /// That is how the CLI's idle watchdog ends a silent MCP call
    /// (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, 30 minutes for a stdio server): it
    /// fails the tool and sends no `notifications/cancelled`, measured on CLI
    /// 2.1.322. `Heartbeat` keeps an ask from tripping it, so this is the
    /// backstop for what the heartbeat does not cover: a client that sends no
    /// progress token, an idle limit shorter than the heartbeat, and any other
    /// way of answering a gated call without a cancel.
    ///
    /// An answered ask is already out of `pending` when its tool's result
    /// arrives, so this only ever finds the abandoned ones. Returns what it
    /// released, for the caller to withdraw.
    pub fn release_resolved(&self, chat_id: &str, tool_use_ids: &[&str]) -> Vec<PermissionRequest> {
        if tool_use_ids.is_empty() {
            return Vec::new();
        }
        let released: Vec<(PermissionRequest, Sender<PermissionDecision>)> = {
            let mut pending = self.pending.lock();
            let ids: Vec<String> = pending
                .iter()
                .filter(|(_, (request, _, _))| {
                    request.chat_id.as_deref() == Some(chat_id)
                        && request
                            .tool_use_id
                            .as_deref()
                            .is_some_and(|id| tool_use_ids.contains(&id))
                })
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| pending.remove(&id))
                .map(|(request, sender, _)| (request, sender))
                .collect()
        };
        released
            .into_iter()
            .map(|(request, sender)| {
                // Wakes the bridge thread, which answers the server and hangs
                // up. That answer is for a call the CLI has already resolved
                // for itself, so nothing on its side is waiting to read it.
                let _ = sender.send(PermissionDecision {
                    id: request.id.clone(),
                    behavior: "deny".into(),
                    message: Some("the CLI stopped waiting on this ask".into()),
                    updated_input: None,
                });
                request
            })
            .collect()
    }

    /// Outstanding asks for one chat, for a window that has just attached to it
    /// and needs to render prompts raised while nothing was watching.
    pub fn pending_for(&self, chat_id: &str) -> Vec<PermissionRequest> {
        self.pending
            .lock()
            .values()
            .filter(|(request, _, _)| request.chat_id.as_deref() == Some(chat_id))
            .map(|(request, _, _)| request.clone())
            .collect()
    }
}

/// Start the bridge listener. Called once from Tauri's `setup`.
///
/// `emit` is handed every new ask; the app broadcasts it to the window.
/// `owns_chat` answers whether a chat id belongs to this process, so an ask from
/// a child orphaned by a previous run is denied instead of parked forever on a
/// prompt no window will ever show.
/// A second instance found the first one holding the socket.
///
/// Not a `String` like the other failures here, because it is the one the caller
/// must act on rather than report: two instances writing the same transcripts is
/// corruption, so the launch has to end.
pub struct AlreadyRunning {
    pub socket: PathBuf,
    /// The owner acknowledged the `show` request and raised its window, so the
    /// launch has already done everything the user wanted and needs no dialog.
    pub raised: bool,
}

/// The one line that means "raise your window", not "approve a tool".
///
/// Deliberately not JSON. An ask is a JSON object, and a build that predates this
/// message would parse a JSON `show` into a `PermissionRequest` with no fields —
/// surfacing a phantom prompt for tool `unknown` in a window the user was not
/// touching. Invalid JSON hits the older `from_str` guard instead and is dropped
/// without a trace, so upgrading costs nothing.
const SHOW_REQUEST: &str = "show";

/// Ask the instance holding `path` to show itself. `true` when it answered.
///
/// The bridge socket is the only thing in a running instance a second launch can
/// reach — there is no single-instance plugin here and no other IPC — so the
/// "raise the existing window" gesture rides on the protocol that already exists.
fn ask_owner_to_show(path: &PathBuf) -> bool {
    let Ok(mut stream) = UnixStream::connect(path) else {
        return false;
    };
    // A short timeout, not none: an owner mid-prompt may be slow, but a launch
    // must not hang on a peer that will never answer.
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(1500)));
    if writeln!(stream, "{SHOW_REQUEST}").is_err() {
        return false;
    }
    let _ = stream.flush();
    let mut reply = String::new();
    let Ok(clone) = stream.try_clone() else {
        return false;
    };
    if BufReader::new(clone).read_line(&mut reply).is_err() {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(&reply)
        .ok()
        .and_then(|value| value.get("shown").and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

pub fn start_bridge<F, W, G, H>(
    state: Arc<PermissionState>,
    path: PathBuf,
    emit: F,
    withdrawn: W,
    owns_chat: G,
    on_show: H,
) -> Result<(), AlreadyRunning>
where
    F: Fn(&PermissionRequest) + Send + Sync + 'static,
    W: Fn(&PermissionRequest) + Send + Sync + 'static,
    G: Fn(&str) -> bool + Send + Sync + 'static,
    H: Fn() + Send + Sync + 'static,
{
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Probe before unlinking. The path is fixed for the app's lifetime because it
    // is baked into every child's `--mcp-config`, and there is no single-instance
    // plugin, so an unconditional `remove_file` + `bind` let a second instance
    // steal the socket: the first instance keeps a listener on an unlinked inode,
    // never accepts again, and every one of its tool prompts vanishes while its
    // turns park on `recv()` forever (which has no timeout, by design). A
    // successful connect means a live bridge owns the socket, so refuse to start
    // instead. The probe connection is dropped immediately; the owner's
    // `handle_ask` reads an empty line and returns.
    //
    // Handed back rather than `process::exit`ed here so the caller can do the
    // two things a user actually wants from a second launch: bring the running
    // window forward, or — when it will not answer — say why nothing happened.
    // The window is configured hidden and only shown once this has passed, so
    // neither path flashes an empty frame.
    if UnixStream::connect(&path).is_ok() {
        return Err(AlreadyRunning {
            raised: ask_owner_to_show(&path),
            socket: path,
        });
    }
    // Nothing answered, so anything still at the path is a stale socket from a
    // crashed run, which would block the bind.
    let _ = std::fs::remove_file(&path);

    // A bind failure is not fatal, unlike the case above: the app is still
    // usable for everything that does not need a prompt, and refusing to start
    // over it would be worse than degrading.
    let listener = match UnixListener::bind(&path) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("permission bridge unavailable: {e}");
            return Ok(());
        }
    };
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    *state.socket_path.lock() = Some(path.to_string_lossy().into_owned());

    let emit = Arc::new(emit);
    let withdrawn: Arc<dyn Fn(&PermissionRequest) + Send + Sync> = Arc::new(withdrawn);
    let owns_chat = Arc::new(owns_chat);
    let on_show = Arc::new(on_show);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let state = Arc::clone(&state);
            let emit = Arc::clone(&emit);
            let withdrawn = Arc::clone(&withdrawn);
            let owns_chat = Arc::clone(&owns_chat);
            let on_show = Arc::clone(&on_show);
            // One thread per ask: each blocks until someone decides, and asks
            // can legitimately overlap when the model batches tool calls.
            std::thread::spawn(move || {
                handle_ask(
                    state,
                    emit.as_ref(),
                    withdrawn,
                    owns_chat.as_ref(),
                    on_show.as_ref(),
                    stream,
                )
            });
        }
    });
    Ok(())
}

/// Longest ask the bridge will buffer. Far above the control cap: an ask
/// carries the tool's whole input, which for a `Write` is the file itself, and
/// a generated lockfile or fixture runs to megabytes.
const MAX_ASK_BYTES: u64 = 64 * 1024 * 1024;

fn handle_ask<F, G, H>(
    state: Arc<PermissionState>,
    emit: &F,
    withdrawn: Arc<dyn Fn(&PermissionRequest) + Send + Sync>,
    owns_chat: &G,
    on_show: &H,
    stream: UnixStream,
) where
    F: Fn(&PermissionRequest) + Send + Sync + 'static,
    G: Fn(&str) -> bool + Send + Sync + 'static,
    H: Fn() + Send + Sync + 'static,
{
    let line = match read_request_line(&stream, MAX_ASK_BYTES) {
        Ok(line) => line,
        // Denied out loud rather than hung up on: a dropped connection is a
        // bridge crash to the CLI, and the model would retry the same write.
        Err(RequestError::TooLarge) => {
            let reply = serde_json::json!({
                "behavior": "deny",
                "message": "this tool call is too large for mangouste to show for approval",
            });
            let mut stream = stream;
            let _ = writeln!(stream, "{reply}");
            let _ = stream.flush();
            return;
        }
        Err(RequestError::Empty) => return,
    };

    // Not an ask at all: a second launch reaching us through the only channel it
    // has, to hand its turn over rather than start a rival. Checked against the
    // raw line and before the parse below, which is what keeps it out of the
    // `PermissionRequest` path entirely.
    if line.trim() == SHOW_REQUEST {
        on_show();
        let mut stream = stream;
        let _ = writeln!(stream, "{}", serde_json::json!({ "shown": true }));
        let _ = stream.flush();
        return;
    }

    let Ok(ask) = serde_json::from_str::<serde_json::Value>(&line) else {
        return;
    };
    let id = uuid_like();
    let request = PermissionRequest {
        id: id.clone(),
        chat_id: ask
            .get("chatId")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        tool_name: ask
            .get("tool_name")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
        tool_use_id: ask
            .get("tool_use_id")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        input: ask.get("input").cloned().unwrap_or(serde_json::Value::Null),
    };

    // An ask naming a chat this process does not hold can only come from a child
    // of a previous run — the CLI keeps the socket path from its `--mcp-config`,
    // so a killed instance's survivors still find the bridge. Waiting on `recv`
    // for a prompt that no window can render is an indefinite park, so deny it
    // and let the CLI report a refusal it can act on.
    //
    // An ask naming no chat at all is refused the same way. Every chat this app
    // starts passes `--permission-chat`, and `cancel_for` matches on the id, so
    // an anonymous ask is one nothing would ever release.
    let refuse = |stream: &UnixStream| {
        let reply = serde_json::json!({
            "behavior": "deny",
            "message": "mangouste no longer owns this session",
        });
        let mut stream = stream;
        let _ = writeln!(stream, "{reply}");
        let _ = stream.flush();
    };
    let Some(chat_id) = request.chat_id.clone() else {
        refuse(&stream);
        return;
    };
    if !owns_chat(&chat_id) {
        refuse(&stream);
        return;
    }

    // `AskUserQuestion` used to be answered right here, on the reasoning that
    // asking permission to ask is a double ask. It is not: the tool reads its
    // answers out of the reply's `updatedInput`, so the permission hop *is* the
    // channel the answers travel on. Allowing it through unchanged left the tool
    // with no answers and no terminal to collect them in, and the turn died on
    // "AskUserQuestion not landing in this session". Every ask reaches a window.

    let (sender, receiver) = channel::<PermissionDecision>();
    state
        .pending
        .lock()
        .insert(id.clone(), (request.clone(), sender, Instant::now()));
    // Checked again now the ask is registered. A kill drops the chat and then
    // sweeps `pending`; one landing between the check above and the insert
    // swept before this ask was there to be found, and nothing else would
    // release it. Either the sweep saw it, or this sees the chat gone.
    if !owns_chat(&chat_id) {
        state.pending.lock().remove(&id);
        refuse(&stream);
        return;
    }
    emit(&request);
    watch_for_hangup(&state, &id, &stream, withdrawn);

    // No timeout, and no longer unbounded in practice: the `owns_chat` gate
    // above means the asking chat is one this process holds, so the wait is
    // bounded by that chat's lifetime — `cancel_for` releases it on kill, and an
    // ask from anything else was denied before it got here. The old five-minute
    // auto-deny is still the wrong answer for a window the user has simply not
    // looked at yet.
    let decision = match receiver.recv() {
        Ok(decision) => decision,
        Err(_) => PermissionDecision {
            id: id.clone(),
            behavior: "deny".into(),
            message: Some("mangouste dropped the request".into()),
            updated_input: None,
        },
    };
    state.pending.lock().remove(&id);

    let mut reply = serde_json::json!({ "behavior": decision.behavior });
    if decision.behavior == "allow" {
        reply["updatedInput"] = decision
            .updated_input
            .unwrap_or_else(|| request.input.clone());
    } else {
        reply["message"] = serde_json::Value::String(
            decision
                .message
                .unwrap_or_else(|| "Denied in mangouste".into()),
        );
    }

    let mut stream = stream;
    let _ = writeln!(stream, "{reply}");
    let _ = stream.flush();
}

/// Withdraw the ask if the server hangs up before anyone decides.
///
/// The server sends nothing after its ask line, so any read returning is the
/// peer going away: the CLI cancelled the call, or the server died with it.
/// Without this the card stayed up, answerable, for a question nothing was
/// waiting on any more. An ask already decided is gone from `pending` by the
/// time the server closes, which is what keeps a normal finish from counting.
fn watch_for_hangup(
    state: &Arc<PermissionState>,
    id: &str,
    stream: &UnixStream,
    withdrawn: Arc<dyn Fn(&PermissionRequest) + Send + Sync>,
) {
    let Ok(mut peer) = stream.try_clone() else {
        return;
    };
    let state = Arc::clone(state);
    let id = id.to_string();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut byte = [0u8; 1];
        let _ = peer.read(&mut byte);
        let Some((request, sender, _)) = state.pending.lock().remove(&id) else {
            return;
        };
        let _ = sender.send(PermissionDecision {
            id,
            behavior: "deny".into(),
            message: Some("the ask was withdrawn before it was answered".into()),
            updated_input: None,
        });
        withdrawn(&request);
    });
}

/// Enough entropy to key a short-lived in-process map, without a uuid crate.
///
/// The counter is what actually guarantees uniqueness: batched tool calls can
/// land inside one clock tick, and nanos+pid alone collided there.
fn uuid_like() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("perm-{nanos:x}-{:x}-{count:x}", std::process::id())
}

/* ---------- the MCP server half ---------- */

/// Run as a stdio MCP server exposing one permission tool.
///
/// Entered from `main` when `--permission-server` is present, long before Tauri
/// starts: this process is spawned by the CLI, not by the user.
///
/// Each `tools/call` runs on its own thread. The loop used to answer inline,
/// which meant one ask nobody answered stalled stdin for the life of the chat:
/// the CLI timed that call out after 30 minutes, but every later ask sat unread
/// in the pipe, so no card ever reached a window and the turn hung on the tool.
/// Reading stays on this thread so `notifications/cancelled` is always seen.
///
/// That 30 minutes is the CLI's idle watchdog, and an open ask now outlives it:
/// see `Heartbeat`.
pub fn run_permission_server(socket_path: String, chat_id: Option<String>) {
    serve(socket_path, chat_id, true)
}

/// Run as a standalone MCP server offering only the control tools.
///
/// Entered as `mangouste --mcp`, for a `claude` started outside the app
/// (`claude mcp add mangouste -- mangouste --mcp`). It has no chat, so it has
/// no permission asks to make and leaves `approve` out of its list.
pub fn run_control_server() {
    let socket = crate::chats::runtime_dir().join("permission.sock");
    serve(socket.to_string_lossy().into_owned(), None, false)
}

fn serve(socket_path: String, chat_id: Option<String>, with_approve: bool) {
    let stdin = std::io::stdin();
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let in_flight: Arc<InFlight> = Arc::default();

    for line in stdin.lock().lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let id = message.get("id").cloned();
        let method = message.get("method").and_then(|m| m.as_str()).unwrap_or("");

        let result = match method {
            "initialize" => serde_json::json!({
                "protocolVersion": message
                    .get("params")
                    .and_then(|p| p.get("protocolVersion"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "mangouste", "version": env!("CARGO_PKG_VERSION") },
            }),
            "tools/list" => {
                let mut tools = Vec::new();
                if with_approve {
                    tools.push(serde_json::json!({
                        "name": "approve",
                        "description": "Ask the mangouste user to approve a tool call",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "tool_name": { "type": "string" },
                                "input": { "type": "object" },
                                "tool_use_id": { "type": "string" },
                            },
                            "required": ["tool_name", "input"],
                        },
                    }));
                }
                tools.extend(crate::control::tool_definitions(chat_id.is_some()));
                serde_json::json!({ "tools": tools })
            }
            "tools/call" => {
                let arguments = message
                    .get("params")
                    .and_then(|p| p.get("arguments"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let name = message
                    .get("params")
                    .and_then(|p| p.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("approve")
                    .to_string();
                // Anything but the permission tool is a control call: forwarded
                // to the app's control socket and answered as ordinary tool
                // output, not as a permission verdict.
                if !with_approve || name != "approve" {
                    let socket = crate::control::socket_beside(&socket_path);
                    let chat_id = chat_id.clone();
                    let stdout = Arc::clone(&stdout);
                    std::thread::spawn(move || {
                        let (text, is_error) =
                            crate::control::call(&socket, chat_id.as_deref(), &name, &arguments);
                        let result = serde_json::json!({
                            "content": [{ "type": "text", "text": text }],
                            "isError": is_error,
                        });
                        write_response(&stdout, id, result);
                    });
                    continue;
                }
                // The id's text form, since ids may be numbers or strings.
                let key = id.as_ref().map(|id| id.to_string());
                let socket_path = socket_path.clone();
                let chat_id = chat_id.clone();
                let stdout = Arc::clone(&stdout);
                let in_flight = Arc::clone(&in_flight);
                // Registered here, on the thread that reads cancels, so a
                // cancel can never be read ahead of the call it names.
                if let Some(key) = &key {
                    in_flight.begin(key);
                }
                // Absent from a client that is not listening for progress, and
                // then there is nothing to report against: the ask simply runs
                // into that client's own limit, as it always did.
                let progress_token = message
                    .get("params")
                    .and_then(|p| p.get("_meta"))
                    .and_then(|m| m.get("progressToken"))
                    .cloned();
                std::thread::spawn(move || {
                    let heartbeat = progress_token
                        .map(|token| Heartbeat::start(Arc::clone(&stdout), token, ASK_HEARTBEAT));
                    let verdict = ask_app(&socket_path, chat_id.as_deref(), &arguments, |stream| {
                        if let Some(key) = &key {
                            in_flight.connected(key, stream);
                        }
                    });
                    if let Some(key) = &key {
                        in_flight.finish(key);
                    }
                    // Before the response, never after: the protocol has
                    // progress stop once the call it reports on is answered.
                    if let Some(heartbeat) = heartbeat {
                        heartbeat.stop();
                    }
                    let result = serde_json::json!({
                        "content": [{ "type": "text", "text": verdict.to_string() }],
                    });
                    write_response(&stdout, id, result);
                });
                continue;
            }
            // The CLI gave up on an ask and said so (the user typed over it, or
            // the turn was interrupted). Hanging up is what tells the daemon,
            // which withdraws the card rather than leaving a prompt that can no
            // longer be answered. When the CLI gives up without saying so, the
            // daemon finds out from the chat's stream instead: see
            // `PermissionState::release_resolved`.
            "notifications/cancelled" => {
                let key = message
                    .get("params")
                    .and_then(|p| p.get("requestId"))
                    .map(|id| id.to_string());
                if let Some(key) = key {
                    in_flight.cancel(&key);
                }
                continue;
            }
            // Notifications carry no id and expect no reply.
            _ if id.is_none() => continue,
            _ => serde_json::json!({}),
        };

        if !write_response(&stdout, id, result) {
            break;
        }
    }
}

/// Where one open `approve` call stands with the daemon.
enum AskSlot {
    /// Dispatched; its thread has not reached the daemon yet.
    Starting,
    /// Waiting on the daemon over this stream.
    Open(UnixStream),
    /// Cancelled before it reached the daemon: hang up as soon as it does.
    Cancelled,
}

/// The server's open `approve` calls, keyed by JSON-RPC id.
///
/// A cancel is read on the stdin thread while the ask it names connects on a
/// thread of its own, so the cancel can be first. With only the connected
/// streams on record it then found nothing to hang up and was dropped, and
/// the ask it should have ended waited on the daemon until the chat died.
/// Every call is on record from the moment it is read, so a cancel always
/// finds it, connected or not.
#[derive(Default)]
struct InFlight {
    slots: Mutex<HashMap<String, AskSlot>>,
}

impl InFlight {
    /// Record a call as it is read. Only on the stdin thread.
    fn begin(&self, key: &str) {
        self.slots.lock().insert(key.to_string(), AskSlot::Starting);
    }

    /// The ask has reached the daemon over `stream`. Hung up on the spot if
    /// the cancel got there first, which the daemon reads as a withdrawal.
    fn connected(&self, key: &str, stream: &UnixStream) {
        let mut slots = self.slots.lock();
        match slots.get(key) {
            Some(AskSlot::Starting) => {
                if let Ok(clone) = stream.try_clone() {
                    slots.insert(key.to_string(), AskSlot::Open(clone));
                }
            }
            Some(AskSlot::Cancelled) => {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
            Some(AskSlot::Open(_)) | None => {}
        }
    }

    /// The CLI cancelled a request. Anything that is not an open ask (a
    /// control call, an ask already answered) is left unrecorded.
    fn cancel(&self, key: &str) {
        let mut slots = self.slots.lock();
        match slots.get(key) {
            Some(AskSlot::Open(stream)) => {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
            Some(AskSlot::Starting) => {
                slots.insert(key.to_string(), AskSlot::Cancelled);
            }
            Some(AskSlot::Cancelled) | None => {}
        }
    }

    /// The call has its verdict, whichever way it ended.
    fn finish(&self, key: &str) {
        self.slots.lock().remove(key);
    }
}

/// One JSON-RPC reply, whole-line under the lock so concurrent asks never
/// interleave on stdout. `false` once the CLI has gone away.
fn write_response(
    stdout: &Mutex<std::io::Stdout>,
    id: Option<serde_json::Value>,
    result: serde_json::Value,
) -> bool {
    write_message(
        stdout,
        &serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }),
    )
}

/// One JSON-RPC message as one line. Generic over the writer so the heartbeat
/// can be tested against a buffer; in the server it is always stdout.
fn write_message<W: Write>(out: &Mutex<W>, message: &serde_json::Value) -> bool {
    let mut out = out.lock();
    writeln!(out, "{message}").is_ok() && out.flush().is_ok()
}

/// How often an open ask tells the CLI it is still alive.
///
/// The CLI compares the age of the last progress against its idle limit, so an
/// ask survives any limit longer than this interval, and the default limit is
/// ninety of them. The cost is one short line.
const ASK_HEARTBEAT: Duration = Duration::from_secs(20);

/// Progress notifications for one open ask, until it is stopped.
///
/// The CLI fails an MCP call that has sent "no response or progress" for its
/// idle limit: `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, 30 minutes by default for a
/// stdio server. An ask is silent by nature, since it is waiting on a person,
/// so a question left for half an hour came back to the model as a tool error
/// and the turn carried on without its answer. Both halves of the bridge say
/// an ask waits for a human; this is what makes the CLI agree.
///
/// Measured on CLI 2.1.322 with the limit set to 5s: a silent `approve` was
/// failed at the watchdog's first 30s tick, and one sending progress on its
/// `_meta.progressToken` every 5s was still open at 75s and its late `allow`
/// ran the tool. Read from that build rather than measured: the CLI's separate
/// cap on a whole call (`MCP_TOOL_TIMEOUT`, 1e8 ms by default) is not reset by
/// progress, so an ask still ends there, a little under 28 hours in.
struct Heartbeat {
    /// Dropped to stop: the thread's wait ends at once, with nothing to send.
    stop: Sender<()>,
    thread: std::thread::JoinHandle<()>,
}

impl Heartbeat {
    fn start<W: Write + Send + 'static>(
        out: Arc<Mutex<W>>,
        token: serde_json::Value,
        every: Duration,
    ) -> Self {
        let (stop, stopped) = channel::<()>();
        let thread = std::thread::spawn(move || {
            // `progress` must increase from one notification to the next.
            let mut beats: u64 = 0;
            while let Err(std::sync::mpsc::RecvTimeoutError::Timeout) = stopped.recv_timeout(every)
            {
                beats += 1;
                let beat = serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": "notifications/progress",
                    "params": { "progressToken": token, "progress": beats },
                });
                // The CLI has gone away; the ask ends with its socket.
                if !write_message(&out, &beat) {
                    break;
                }
            }
        });
        Self { stop, thread }
    }

    /// Stop, and wait until the last beat is fully written or never started.
    fn stop(self) {
        drop(self.stop);
        let _ = self.thread.join();
    }
}

/// Forward one ask to the daemon and block for the answer.
///
/// `on_connected` sees the stream before the wait starts, so the caller can
/// hang it up from another thread when the CLI cancels the ask.
fn ask_app(
    socket_path: &str,
    chat_id: Option<&str>,
    arguments: &serde_json::Value,
    on_connected: impl FnOnce(&UnixStream),
) -> serde_json::Value {
    let deny = |reason: &str| serde_json::json!({ "behavior": "deny", "message": reason });

    let Ok(mut stream) = UnixStream::connect(socket_path) else {
        return deny("mangouste is not reachable to ask for permission");
    };
    // No read timeout, to match the bridge: the session waits for a human
    // rather than denying itself while every window is closed.

    // Tag the ask with the chat it came from, so the daemon can route it to the
    // pane that is actually asking rather than to whichever one looks busy.
    let mut ask = arguments.clone();
    if let (Some(object), Some(chat_id)) = (ask.as_object_mut(), chat_id) {
        object.insert(
            "chatId".into(),
            serde_json::Value::String(chat_id.to_string()),
        );
    }
    if writeln!(stream, "{ask}").is_err() {
        return deny("could not reach mangouste");
    }
    let _ = stream.flush();
    on_connected(&stream);

    let mut reply = String::new();
    match BufReader::new(&stream).read_line(&mut reply) {
        Ok(0) | Err(_) => return deny("no answer from mangouste"),
        Ok(_) => {}
    }
    serde_json::from_str(reply.trim()).unwrap_or_else(|_| deny("malformed answer from mangouste"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(id: &str) -> PermissionRequest {
        PermissionRequest {
            id: id.into(),
            chat_id: Some("chat".into()),
            tool_name: "AskUserQuestion".into(),
            tool_use_id: None,
            input: serde_json::Value::Null,
        }
    }

    /// A server hanging up on an open ask releases the waiting bridge thread
    /// and withdraws the card, instead of parking both until the chat dies.
    #[test]
    fn hangup_withdraws_a_pending_ask() {
        let state = Arc::new(PermissionState::default());
        let (bridge, server) = UnixStream::pair().unwrap();
        let (sender, receiver) = channel();
        state
            .pending
            .lock()
            .insert("a".into(), (ask("a"), sender, Instant::now()));
        let (told, heard) = channel();
        watch_for_hangup(
            &state,
            "a",
            &bridge,
            Arc::new(move |r| told.send(r.id.clone()).unwrap()),
        );

        drop(server);

        let timeout = std::time::Duration::from_secs(2);
        assert_eq!(receiver.recv_timeout(timeout).unwrap().behavior, "deny");
        assert_eq!(heard.recv_timeout(timeout).unwrap(), "a");
        assert!(state.pending_for("chat").is_empty());
    }

    /// The server closing after it has its answer is the normal end, not a
    /// withdrawal: the ask is already out of `pending` by then.
    #[test]
    fn hangup_after_a_decision_withdraws_nothing() {
        let state = Arc::new(PermissionState::default());
        let (bridge, server) = UnixStream::pair().unwrap();
        let (told, heard) = channel::<String>();
        watch_for_hangup(
            &state,
            "a",
            &bridge,
            Arc::new(move |r| told.send(r.id.clone()).unwrap()),
        );

        drop(server);

        assert!(heard
            .recv_timeout(std::time::Duration::from_millis(300))
            .is_err());
    }

    /// An ask only blocks the session once it has outlived an auto-allow.
    #[test]
    fn awaiting_chats_waits_out_the_settle_window() {
        let state = PermissionState::default();
        let (fresh, _fresh_rx) = channel();
        let (old, _old_rx) = channel();
        let mut settled = ask("b");
        settled.chat_id = Some("other".into());
        state
            .pending
            .lock()
            .insert("a".into(), (ask("a"), fresh, Instant::now()));
        state
            .pending
            .lock()
            .insert("b".into(), (settled, old, Instant::now() - AWAITING_SETTLE));

        let awaiting = state.awaiting_chats();
        assert!(awaiting.contains("other"));
        assert!(!awaiting.contains("chat"));
    }

    /// Answering takes the ask out of `pending` at once, so a rescan fired
    /// right after the answer cannot still read the session as blocked.
    #[test]
    fn respond_clears_the_ask_immediately() {
        let state = PermissionState::default();
        let (sender, receiver) = channel();
        state.pending.lock().insert(
            "a".into(),
            (ask("a"), sender, Instant::now() - AWAITING_SETTLE),
        );

        state
            .respond(PermissionDecision {
                id: "a".into(),
                behavior: "allow".into(),
                message: None,
                updated_input: None,
            })
            .unwrap();

        assert!(state.awaiting_chats().is_empty());
        assert_eq!(receiver.recv().unwrap().behavior, "allow");
        assert!(state
            .respond(PermissionDecision {
                id: "a".into(),
                behavior: "allow".into(),
                message: None,
                updated_input: None,
            })
            .is_err());
    }

    fn ask_for(id: &str, chat_id: &str, tool_use_id: Option<&str>) -> PermissionRequest {
        PermissionRequest {
            chat_id: Some(chat_id.into()),
            tool_use_id: tool_use_id.map(str::to_string),
            ..ask(id)
        }
    }

    /// The CLI answering a gated tool call itself is the end of the ask: the
    /// bridge thread is released and the session stops reading as blocked.
    #[test]
    fn a_tool_result_releases_the_ask_that_gated_it() {
        let state = PermissionState::default();
        let (sender, receiver) = channel();
        state.pending.lock().insert(
            "a".into(),
            (
                ask_for("a", "chat", Some("toolu_1")),
                sender,
                Instant::now() - AWAITING_SETTLE,
            ),
        );
        assert!(state.awaiting_chats().contains("chat"));

        let released = state.release_resolved("chat", &["toolu_0", "toolu_1"]);

        assert_eq!(
            released.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["a"]
        );
        assert_eq!(receiver.recv().unwrap().behavior, "deny");
        assert!(state.awaiting_chats().is_empty());
        assert!(state.pending_for("chat").is_empty());
    }

    /// Only the ask for that tool call, in that chat. Tool-use ids are the
    /// CLI's, so another chat's ask or another call's ask is not this one, and
    /// an ask that named no call cannot be matched to a result at all.
    #[test]
    fn a_tool_result_releases_no_other_ask() {
        let state = PermissionState::default();
        let mut receivers = Vec::new();
        for request in [
            ask_for("other-chat", "elsewhere", Some("toolu_1")),
            ask_for("other-call", "chat", Some("toolu_2")),
            ask_for("no-call", "chat", None),
        ] {
            let (sender, receiver) = channel();
            receivers.push(receiver);
            state
                .pending
                .lock()
                .insert(request.id.clone(), (request, sender, Instant::now()));
        }

        assert!(state.release_resolved("chat", &["toolu_1"]).is_empty());
        assert!(state.release_resolved("chat", &[]).is_empty());

        assert_eq!(state.pending_for("chat").len(), 2);
        assert_eq!(state.pending_for("elsewhere").len(), 1);
        assert!(receivers.iter().all(|r| r.try_recv().is_err()));
    }

    fn lines_of(out: &Mutex<Vec<u8>>) -> Vec<serde_json::Value> {
        String::from_utf8(out.lock().clone())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    /// Whether the other end of `peer` hangs up within `wait`.
    fn hangs_up_within(peer: &UnixStream, wait: Duration) -> bool {
        use std::io::Read;
        peer.set_read_timeout(Some(wait)).unwrap();
        let mut byte = [0u8; 1];
        let mut peer = peer;
        matches!(peer.read(&mut byte), Ok(0))
    }

    /// The ordinary order: the ask is waiting on the daemon when the CLI
    /// cancels it, and the cancel hangs up.
    #[test]
    fn a_cancel_hangs_up_an_ask_that_is_waiting() {
        let in_flight = InFlight::default();
        let (ask, daemon) = UnixStream::pair().unwrap();
        in_flight.begin("1");
        in_flight.connected("1", &ask);
        assert!(!hangs_up_within(&daemon, Duration::from_millis(50)));

        in_flight.cancel("1");

        assert!(hangs_up_within(&daemon, Duration::from_secs(2)));
    }

    /// The cancel is read on one thread and the ask connects on another, so
    /// the cancel can be first. It used to find nothing to hang up and was
    /// dropped, leaving an ask nothing would ever release.
    #[test]
    fn a_cancel_that_beats_the_connection_hangs_up_on_arrival() {
        let in_flight = InFlight::default();
        let (ask, daemon) = UnixStream::pair().unwrap();
        in_flight.begin("1");

        in_flight.cancel("1");
        in_flight.connected("1", &ask);

        assert!(hangs_up_within(&daemon, Duration::from_secs(2)));
    }

    /// A cancel for anything that is not an open ask (a control call, an ask
    /// already answered) is not remembered: nothing would ever clear it.
    #[test]
    fn a_cancel_for_no_open_ask_leaves_nothing_behind() {
        let in_flight = InFlight::default();
        in_flight.cancel("9");
        in_flight.begin("1");
        in_flight.finish("1");
        in_flight.cancel("1");

        assert!(in_flight.slots.lock().is_empty());
    }

    /// While an ask is open the server keeps telling the CLI it is alive, on
    /// the token the call came with, and says nothing more once it is stopped:
    /// the protocol has progress end when the call's response is sent.
    #[test]
    fn heartbeat_reports_progress_until_it_is_stopped() {
        let out = Arc::new(Mutex::new(Vec::new()));
        let heartbeat = Heartbeat::start(
            Arc::clone(&out),
            serde_json::json!(7),
            Duration::from_millis(10),
        );
        // Waited for, not slept for: a starved runner still gets its beats.
        let deadline = Instant::now() + Duration::from_secs(10);
        while lines_of(&out).len() < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        heartbeat.stop();

        let beats = lines_of(&out);
        assert!(beats.len() >= 2, "expected several beats, got {beats:?}");
        for (index, beat) in beats.iter().enumerate() {
            assert_eq!(beat["method"], "notifications/progress");
            assert_eq!(beat["params"]["progressToken"], 7);
            assert_eq!(beat["params"]["progress"], index as u64 + 1);
            assert!(beat.get("id").is_none());
        }

        std::thread::sleep(Duration::from_millis(40));
        assert_eq!(lines_of(&out).len(), beats.len());
    }

    /// The upgrade story rests on this one property.
    ///
    /// A build that predates the show message parses every incoming line as an
    /// ask. If `SHOW_REQUEST` were valid JSON it would become a
    /// `PermissionRequest` for tool `unknown` and raise a prompt in a window
    /// nobody touched; being invalid, it hits that build's parse guard and is
    /// dropped. Anyone tempted to "tidy" this into `{"type":"show"}` breaks a
    /// case they cannot test, because the other half of it is already shipped.
    #[test]
    fn show_request_is_not_valid_json() {
        assert!(serde_json::from_str::<serde_json::Value>(SHOW_REQUEST).is_err());
    }
}
