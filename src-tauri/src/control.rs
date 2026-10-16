//! Session control: tools a session calls to make mangouste do things.
//!
//! The permission server already runs inside every chat mangouste spawns, so it
//! also carries a handful of tools the model can call: schedule a follow-up,
//! open a new session, fork one. Each call is forwarded to the app over its own
//! unix socket and answered by the main window, which owns the prompt store and
//! the schedule clock.
//!
//! A socket of its own rather than a new message on `permission.sock`: the
//! server is spawned from whatever binary is on disk, which after an upgrade is
//! newer than the app still running. An older bridge reads every line as a
//! permission ask, so a control call sent there would surface as a phantom
//! prompt for tool `unknown`. An older app has no `control.sock` at all, which
//! fails as "not reachable" instead.
//!
//! The same server also runs standalone as `mangouste --mcp`, for a `claude`
//! started outside the app. That one has no chat id, so it cannot mean "this
//! session" and never offers the permission tool.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const EVENT_REQUEST: &str = "control://request";

/// Next to `permission.sock`, in the same private runtime dir.
pub const SOCKET_NAME: &str = "control.sock";

/// How long a call waits on the window. Every tool is a quick store edit or a
/// tab opening, so a window that has not answered by then is not going to.
const REPLY_TIMEOUT: Duration = Duration::from_secs(30);

/// The tools this module answers, in the order `tools/list` shows them.
const TOOL_NAMES: [&str; 5] = [
    "schedule_prompt",
    "list_scheduled",
    "cancel_scheduled",
    "new_session",
    "fork_session",
];

pub fn is_control_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

/// The control socket that sits beside a permission socket.
pub fn socket_beside(permission_socket: &str) -> PathBuf {
    Path::new(permission_socket).with_file_name(SOCKET_NAME)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRequest {
    pub id: String,
    /// The chat that called, when it is one of ours. `None` from `--mcp`.
    ///
    /// Taken from the server's command line, which the app wrote, never from
    /// the tool arguments, which the model wrote.
    pub chat_id: Option<String>,
    /// The caller's session and repo, filled in from the chat manager before
    /// the call reaches a window. The window could only guess them from its own
    /// tabs, and a chat raised by a second window is in none of those.
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    pub tool: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlReply {
    pub id: String,
    pub ok: bool,
    #[serde(default)]
    pub result: Value,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct ControlState {
    pending: Mutex<HashMap<String, Sender<ControlReply>>>,
}

impl ControlState {
    pub fn respond(&self, reply: ControlReply) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .remove(&reply.id)
            .ok_or("no such pending control request")?;
        sender.send(reply).map_err(|e| e.to_string())
    }
}

/// Start the control listener. Called from `setup` once the permission bridge
/// has established that this is the only instance, so a socket already at the
/// path can only be a crashed run's leftover.
///
/// `emit` fills in who called and hands the call to the main window. An error
/// is the reason it could not, and goes back to the model as the answer.
pub fn start_bridge<F>(state: Arc<ControlState>, path: PathBuf, emit: F)
where
    F: Fn(&mut ControlRequest) -> Result<(), String> + Send + Sync + 'static,
{
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("control bridge unavailable: {e}");
            return;
        }
    };
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    let emit = Arc::new(emit);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let state = Arc::clone(&state);
            let emit = Arc::clone(&emit);
            std::thread::spawn(move || handle_call(&state, emit.as_ref(), stream));
        }
    });
}

fn handle_call<F>(state: &ControlState, emit: &F, stream: UnixStream)
where
    F: Fn(&mut ControlRequest) -> Result<(), String>,
{
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(clone) => clone,
        Err(_) => return,
    });
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
        return;
    }
    let reply = match parse_call(&line) {
        Ok(request) => dispatch(state, emit, request),
        Err(error) => failure(error),
    };
    let mut stream = stream;
    let _ = writeln!(stream, "{reply}");
    let _ = stream.flush();
}

/// One line from a server, checked before anything reaches a window.
fn parse_call(line: &str) -> Result<ControlRequest, String> {
    let call: Value = serde_json::from_str(line).map_err(|_| "malformed control call")?;
    let tool = call
        .get("tool")
        .and_then(Value::as_str)
        .filter(|tool| is_control_tool(tool))
        .ok_or("unknown control tool")?;
    Ok(ControlRequest {
        id: next_id(),
        chat_id: call
            .get("chatId")
            .and_then(Value::as_str)
            .map(str::to_string),
        session_id: None,
        cwd: None,
        tool: tool.to_string(),
        arguments: call.get("arguments").cloned().unwrap_or_else(|| json!({})),
    })
}

fn dispatch<F>(state: &ControlState, emit: &F, mut request: ControlRequest) -> Value
where
    F: Fn(&mut ControlRequest) -> Result<(), String>,
{
    let (sender, receiver) = channel();
    state.pending.lock().insert(request.id.clone(), sender);
    if let Err(error) = emit(&mut request) {
        state.pending.lock().remove(&request.id);
        return failure(error);
    }
    let reply = receiver.recv_timeout(REPLY_TIMEOUT);
    state.pending.lock().remove(&request.id);
    match reply {
        Ok(reply) if reply.ok => json!({ "ok": true, "result": reply.result }),
        Ok(reply) => failure(reply.error.unwrap_or_else(|| "mangouste refused".into())),
        // The window is not told to stop, so the call may still land after
        // this. Saying so keeps a retry from doing the same thing twice.
        Err(_) => failure(
            "mangouste did not answer in time; the call may still have been applied, \
             so check list_scheduled or the open tabs before retrying"
                .into(),
        ),
    }
}

fn failure(error: String) -> Value {
    json!({ "ok": false, "error": error })
}

fn next_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!(
        "ctl-{:x}-{:x}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/* ---------- the MCP server half ---------- */

/// Forward one tool call to the app and wait for its answer.
///
/// Returns the text the model sees and whether it is an error.
pub fn call(socket: &Path, chat_id: Option<&str>, tool: &str, arguments: &Value) -> (String, bool) {
    let Ok(mut stream) = UnixStream::connect(socket) else {
        return ("mangouste is not running".into(), true);
    };
    // A little over the bridge's own wait, so its timeout is the one reported.
    let _ = stream.set_read_timeout(Some(REPLY_TIMEOUT + Duration::from_secs(5)));
    let line = json!({ "chatId": chat_id, "tool": tool, "arguments": arguments });
    if writeln!(stream, "{line}").is_err() || stream.flush().is_err() {
        return ("could not reach mangouste".into(), true);
    }
    let mut reply = String::new();
    match BufReader::new(&stream).read_line(&mut reply) {
        Ok(0) | Err(_) => return ("no answer from mangouste".into(), true),
        Ok(_) => {}
    }
    let Ok(reply) = serde_json::from_str::<Value>(reply.trim()) else {
        return ("malformed answer from mangouste".into(), true);
    };
    if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        let result = reply.get("result").cloned().unwrap_or(Value::Null);
        let text = serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string());
        (text, false)
    } else {
        let error = reply
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("mangouste refused");
        (error.to_string(), true)
    }
}

/// The control tools' `tools/list` entries.
///
/// `in_chat` is whether the server was spawned for one of mangouste's chats:
/// only then is there a "this session" to follow up in or fork.
pub fn tool_definitions(in_chat: bool) -> Vec<Value> {
    let this_session = if in_chat {
        " Defaults to the session making this call."
    } else {
        " Required: this server is not attached to a mangouste session."
    };
    vec![
        json!({
            "name": "schedule_prompt",
            "description": format!(
                "Schedule a prompt to be sent later by mangouste, once or on a cron schedule. \
                 Give exactly one of `at`, `in_minutes` or `cron`. With `target` \
                 \"this_session\" the prompt is sent into the session named by `session_id` \
                 (a follow-up); with \"new_session\" it starts a fresh session in `project`.{this_session} \
                 Runs only while mangouste is open; a one-off that came due while it was closed \
                 runs at the next launch. Returns the scheduled prompt's id."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "The prompt to send." },
                    "label": { "type": "string", "description": "Short name shown in mangouste's Prompts view." },
                    "at": { "type": "string", "description": "One-off run time, ISO 8601 with offset, e.g. 2026-10-15T09:00:00+02:00." },
                    "in_minutes": { "type": "number", "description": "One-off run this many minutes from now." },
                    "cron": { "type": "string", "description": "Recurring run, five-field cron in local time, e.g. \"0 9 * * 1-5\"." },
                    "target": { "type": "string", "enum": ["this_session", "new_session"] },
                    "session_id": { "type": "string", "description": "Session uuid to follow up in, for target this_session." },
                    "project": { "type": "string", "description": "Repo path for target new_session. Defaults to the caller's repo; a mangouste session may only name its own repo or a folder in it." },
                },
                "required": ["text"],
            },
        }),
        json!({
            "name": "list_scheduled",
            "description": "List the prompts this session has scheduled, with their ids and next runs. Prompts made by hand or by other sessions are not shown.",
            "inputSchema": { "type": "object", "properties": {} },
        }),
        json!({
            "name": "cancel_scheduled",
            "description": "Remove a prompt this session scheduled, by the id schedule_prompt or list_scheduled gave.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"],
            },
        }),
        json!({
            "name": "new_session",
            "description": "Open a new mangouste session in a repo and send it a prompt. It opens in the background unless `focus` is set.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "The first prompt." },
                    "project": { "type": "string", "description": "Repo path. Defaults to the caller's repo; a mangouste session may only name its own repo or a folder in it." },
                    "focus": { "type": "boolean", "description": "Bring the new tab to the front." },
                },
                "required": ["text"],
            },
        }),
        json!({
            "name": "fork_session",
            "description": format!(
                "Fork a session into a new mangouste tab: the fork starts with the whole \
                 conversation so far and then goes its own way. Optionally send it a prompt.{this_session}"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "Session uuid to fork." },
                    "text": { "type": "string", "description": "Prompt to send the fork." },
                    "focus": { "type": "boolean", "description": "Bring the fork's tab to the front." },
                },
            },
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_listed_tool_is_routed() {
        let listed: Vec<String> = tool_definitions(true)
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(listed, TOOL_NAMES);
    }

    #[test]
    fn parse_rejects_unknown_tools_and_bad_json() {
        assert!(parse_call("not json").is_err());
        assert!(parse_call(r#"{"tool":"approve"}"#).is_err());
        let request = parse_call(r#"{"tool":"list_scheduled","chatId":"c"}"#).unwrap();
        assert_eq!(request.chat_id.as_deref(), Some("c"));
        assert_eq!(request.arguments, json!({}));
    }

    #[test]
    fn socket_sits_beside_the_permission_socket() {
        assert_eq!(
            socket_beside("/run/user/1/mangouste/permission.sock"),
            PathBuf::from("/run/user/1/mangouste/control.sock")
        );
    }

    #[test]
    fn no_window_fails_fast_and_leaves_nothing_pending() {
        let state = ControlState::default();
        let request = parse_call(r#"{"tool":"list_scheduled"}"#).unwrap();
        let refuse = |_: &mut ControlRequest| Err("no window".to_string());
        let reply = dispatch(&state, &refuse, request);
        assert_eq!(reply, json!({ "ok": false, "error": "no window" }));
        assert!(state.pending.lock().is_empty());
    }

    #[test]
    fn a_window_reply_reaches_the_caller() {
        let state = Arc::new(ControlState::default());
        let request = parse_call(r#"{"tool":"list_scheduled"}"#).unwrap();
        let answering = Arc::clone(&state);
        let emit = move |request: &mut ControlRequest| {
            let id = request.id.clone();
            let answering = Arc::clone(&answering);
            std::thread::spawn(move || {
                // Wait for the dispatcher to park on its channel.
                while answering.pending.lock().is_empty() {
                    std::thread::yield_now();
                }
                answering
                    .respond(ControlReply {
                        id,
                        ok: true,
                        result: json!([]),
                        error: None,
                    })
                    .unwrap();
            });
            Ok(())
        };
        let reply = dispatch(&state, &emit, request);
        assert_eq!(reply, json!({ "ok": true, "result": [] }));
    }

    #[test]
    fn end_to_end_over_a_socket() {
        let dir = std::env::temp_dir().join(format!("mangouste-control-{}", next_id()));
        let path = dir.join(SOCKET_NAME);
        let state = Arc::new(ControlState::default());
        let answering = Arc::clone(&state);
        start_bridge(
            Arc::clone(&state),
            path.clone(),
            move |request: &mut ControlRequest| {
                let reply = ControlReply {
                    id: request.id.clone(),
                    ok: false,
                    result: Value::Null,
                    error: Some(format!("{} from {:?}", request.tool, request.chat_id)),
                };
                let answering = Arc::clone(&answering);
                std::thread::spawn(move || {
                    while answering.pending.lock().is_empty() {
                        std::thread::yield_now();
                    }
                    answering.respond(reply).unwrap();
                });
                Ok(())
            },
        );
        let (text, is_error) = call(&path, Some("chat-1"), "list_scheduled", &json!({}));
        assert!(is_error);
        assert_eq!(text, r#"list_scheduled from Some("chat-1")"#);
        let _ = std::fs::remove_dir_all(dir);
    }
}
