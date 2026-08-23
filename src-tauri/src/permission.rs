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

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

pub const EVENT_REQUEST: &str = "permission://request";

/// Tools whose only effect is to put a question in front of the user.
///
/// Prompting for these is a double ask: the human answers "may I ask you
/// something?" and then answers the question itself, and a denial leaves the
/// agent unable to do the one thing it was trying to do — talk to them. There is
/// nothing to guard, so the bridge answers on the user's behalf and the ask
/// never reaches a window.
///
/// `ExitPlanMode` deliberately stays out: approving a plan *is* the decision.
const AUTO_ALLOWED_TOOLS: [&str; 1] = ["AskUserQuestion"];

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

#[derive(Default)]
pub struct PermissionState {
    /// The ask is kept next to its channel so a window that attaches later can
    /// be handed prompts raised while nothing was watching.
    pending: Mutex<HashMap<String, (PermissionRequest, Sender<PermissionDecision>)>>,
    socket_path: Mutex<Option<String>>,
}

impl PermissionState {
    pub fn socket_path(&self) -> Option<String> {
        self.socket_path.lock().clone()
    }

    /// Answer a pending prompt. The waiting bridge thread unblocks and replies
    /// to the MCP server, which returns the verdict to the CLI.
    pub fn respond(&self, decision: PermissionDecision) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .get(&decision.id)
            .map(|(_, sender)| sender.clone())
            .ok_or("no such pending permission request")?;
        sender.send(decision).map_err(|e| e.to_string())
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
                .filter(|(_, (request, _))| request.chat_id.as_deref() == Some(chat_id))
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| pending.remove(&id).map(|(_, sender)| (id, sender)))
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

    /// Outstanding asks for one chat, for a window that has just attached to it
    /// and needs to render prompts raised while nothing was watching.
    pub fn pending_for(&self, chat_id: &str) -> Vec<PermissionRequest> {
        self.pending
            .lock()
            .values()
            .filter(|(request, _)| request.chat_id.as_deref() == Some(chat_id))
            .map(|(request, _)| request.clone())
            .collect()
    }
}

/// Start the bridge listener. Called once from Tauri's `setup`.
///
/// `emit` is handed every new ask; the app broadcasts it to the window.
/// `owns_chat` answers whether a chat id belongs to this process, so an ask from
/// a child orphaned by a previous run is denied instead of parked forever on a
/// prompt no window will ever show.
pub fn start_bridge<F, G>(
    state: Arc<PermissionState>,
    path: PathBuf,
    emit: F,
    owns_chat: G,
) -> Result<(), String>
where
    F: Fn(&PermissionRequest) + Send + Sync + 'static,
    G: Fn(&str) -> bool + Send + Sync + 'static,
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
    // Reported as an error rather than `process::exit`: Tauri creates the
    // configured window before it runs `setup`, so exiting here flashes a window
    // and disappears, with the reason on a stderr nobody is reading. Handing the
    // error back lets the caller fail the build with a message (a dialog would
    // be better still — `tauri_plugin_dialog` is already registered).
    if UnixStream::connect(&path).is_ok() {
        return Err(format!(
            "mangouste is already running: another instance owns the permission \
             bridge at {}. Close it before starting a second one.",
            path.display()
        ));
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
    let owns_chat = Arc::new(owns_chat);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let state = Arc::clone(&state);
            let emit = Arc::clone(&emit);
            let owns_chat = Arc::clone(&owns_chat);
            // One thread per ask: each blocks until someone decides, and asks
            // can legitimately overlap when the model batches tool calls.
            std::thread::spawn(move || {
                handle_ask(state, emit.as_ref(), owns_chat.as_ref(), stream)
            });
        }
    });
    Ok(())
}

fn handle_ask<F, G>(state: Arc<PermissionState>, emit: &F, owns_chat: &G, stream: UnixStream)
where
    F: Fn(&PermissionRequest) + Send + Sync + 'static,
    G: Fn(&str) -> bool + Send + Sync + 'static,
{
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(clone) => clone,
        Err(_) => return,
    });
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
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
    if let Some(chat_id) = request.chat_id.as_deref() {
        if !owns_chat(chat_id) {
            let mut stream = stream;
            let reply = serde_json::json!({
                "behavior": "deny",
                "message": "mangouste no longer owns this session",
            });
            let _ = writeln!(stream, "{reply}");
            let _ = stream.flush();
            return;
        }
    }

    // Answered here rather than in the window: nothing is pending, so no card is
    // rendered, no timer runs, and the transcript goes straight to the question.
    if AUTO_ALLOWED_TOOLS.contains(&request.tool_name.as_str()) {
        let mut stream = stream;
        let reply = serde_json::json!({
            "behavior": "allow",
            "updatedInput": request.input,
        });
        let _ = writeln!(stream, "{reply}");
        let _ = stream.flush();
        return;
    }

    let (sender, receiver) = channel::<PermissionDecision>();
    state
        .pending
        .lock()
        .insert(id.clone(), (request.clone(), sender));
    emit(&request);

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
            decision.message.unwrap_or_else(|| "Denied in mangouste".into()),
        );
    }

    let mut stream = stream;
    let _ = writeln!(stream, "{reply}");
    let _ = stream.flush();
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
pub fn run_permission_server(socket_path: String, chat_id: Option<String>) {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

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
            "tools/list" => serde_json::json!({
                "tools": [{
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
                }],
            }),
            "tools/call" => {
                let arguments = message
                    .get("params")
                    .and_then(|p| p.get("arguments"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let verdict = ask_app(&socket_path, chat_id.as_deref(), &arguments);
                serde_json::json!({
                    "content": [{ "type": "text", "text": verdict.to_string() }],
                })
            }
            // Notifications carry no id and expect no reply.
            _ if id.is_none() => continue,
            _ => serde_json::json!({}),
        };

        let response = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result });
        if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
            break;
        }
    }
}

/// Forward one ask to the daemon and block for the answer.
fn ask_app(
    socket_path: &str,
    chat_id: Option<&str>,
    arguments: &serde_json::Value,
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
        object.insert("chatId".into(), serde_json::Value::String(chat_id.to_string()));
    }
    if writeln!(stream, "{ask}").is_err() {
        return deny("could not reach mangouste");
    }
    let _ = stream.flush();

    let mut reply = String::new();
    if BufReader::new(&stream).read_line(&mut reply).is_err() {
        return deny("no answer from mangouste");
    }
    serde_json::from_str(reply.trim()).unwrap_or_else(|_| deny("malformed answer from mangouste"))
}
