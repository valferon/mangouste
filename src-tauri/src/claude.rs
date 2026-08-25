//! Tauri commands over the in-process chat manager.
//!
//! Children are owned by `chats.rs` inside this process, so closing the window
//! ends them. Nothing here outlives the GUI.
//!
//! `start` and `restart` take the calling `Window` for that reason and no other:
//! with a second window open, "closing the window" has to name one, and the one
//! it names is whichever asked for the chat.

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{State, Window};

use crate::chats::{self, ChatManager, ChatStatus, StartOptions};
use crate::permission::{PermissionDecision, PermissionState};

/// Spawn a chat, or attach to the live process already running that id.
#[tauri::command]
pub fn claude_start(
    manager: State<'_, Arc<ChatManager>>,
    window: Window,
    options: StartOptions,
) -> Result<ChatStatus, String> {
    chats::start(&manager, window.label(), options)
}

/// Send a user turn. `text` goes through as a single text block.
///
/// `async` so the stdin write runs off the main thread: a pasted image is
/// base64 well past the pipe buffer, and the write parks until the CLI drains.
#[tauri::command(async)]
pub fn claude_send(
    manager: State<'_, Arc<ChatManager>>,
    chat_id: String,
    text: String,
) -> Result<(), String> {
    manager.send_frame(
        &chat_id,
        &json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
        }),
    )
}

/// Send an already-formed frame, for shapes the UI builds itself (images).
/// `async` for the same reason as `claude_send`.
#[tauri::command(async)]
pub fn claude_send_raw(
    manager: State<'_, Arc<ChatManager>>,
    chat_id: String,
    frame: Value,
) -> Result<(), String> {
    manager.send_frame(&chat_id, &frame)
}

/// Interrupt the current turn without killing the process.
#[tauri::command]
pub fn claude_interrupt(
    manager: State<'_, Arc<ChatManager>>,
    chat_id: String,
    request_id: String,
) -> Result<(), String> {
    manager.send_frame(
        &chat_id,
        &json!({
            "type": "control_request",
            "request_id": request_id,
            "request": { "subtype": "interrupt" }
        }),
    )
}

/// Kill whatever is under this id and spawn fresh.
///
/// `start` attaches to a live process, so an explicit restart is the only way to
/// apply a changed permission mode or recover a wedged session.
#[tauri::command]
pub fn claude_restart(
    manager: State<'_, Arc<ChatManager>>,
    window: Window,
    options: StartOptions,
) -> Result<ChatStatus, String> {
    manager.kill(&options.chat_id, None);
    chats::start(&manager, window.label(), options)
}

/// Stop watching a chat.
///
/// A no-op now that children die with the window: there is no detached state to
/// bookkeep. Kept so the pane's unmount path does not have to special-case it,
/// and so switching repos does not kill a turn that is still streaming.
#[tauri::command]
pub fn claude_detach(_chat_id: String) -> Result<(), String> {
    Ok(())
}

/// Kill one chat. `instance` makes a late call from a torn-down pane a no-op.
#[tauri::command]
pub fn claude_kill(
    manager: State<'_, Arc<ChatManager>>,
    chat_id: String,
    instance: Option<u64>,
) -> Result<(), String> {
    manager.kill(&chat_id, instance);
    Ok(())
}

/// Answer a pending tool-permission prompt.
#[tauri::command]
pub fn permission_respond(
    permission: State<'_, Arc<PermissionState>>,
    decision: PermissionDecision,
) -> Result<(), String> {
    permission.respond(decision)
}

#[tauri::command]
pub fn claude_status(manager: State<'_, Arc<ChatManager>>) -> Vec<ChatStatus> {
    manager.statuses()
}
