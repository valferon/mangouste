mod chats;
mod claude;
mod git;
mod primary;
mod permission;
mod pty;
mod sessions;
mod stats;
mod usage;
mod workspace;

use std::sync::Arc;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_full::new_debouncer;
use tauri::{AppHandle, Emitter, Manager};

pub use permission::run_permission_server;

pub const EVENT_SESSIONS_CHANGED: &str = "sessions://changed";

/// Transcripts are appended to continuously during a turn, so the watcher is
/// debounced hard — the sidebar only needs to know that *something* changed.
///
/// 400ms was too tight: a single streaming session produced a rescan several
/// times a second, and each one re-read every transcript on the machine.
const SESSIONS_DEBOUNCE: Duration = Duration::from_millis(1500);

/// Watch `~/.claude/projects` and ping the frontend when any transcript changes.
///
/// The debouncer is leaked deliberately: it must outlive setup and live for the
/// whole process, and there is nothing to drop it from.
fn watch_sessions(app: AppHandle) {
    let Some(root) = sessions::projects_root() else {
        return;
    };
    if !root.is_dir() {
        return;
    }

    std::thread::spawn(move || {
        let result = new_debouncer(SESSIONS_DEBOUNCE, None, move |result| {
            if let Ok(events) = result {
                let _: Vec<notify_debouncer_full::DebouncedEvent> = events;
                let _ = app.emit(EVENT_SESSIONS_CHANGED, ());
            }
        });

        match result {
            Ok(mut debouncer) => {
                if debouncer.watch(&root, RecursiveMode::Recursive).is_ok() {
                    std::mem::forget(debouncer);
                }
            }
            Err(e) => eprintln!("session watcher failed to start: {e}"),
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(chats::ChatManager::default()))
        .manage(Arc::new(permission::PermissionState::default()))
        .manage(pty::PtyState::default())
        .manage(sessions::SessionCache::default())
        .manage(stats::StatsCache::default())
        .setup(|app| {
            watch_sessions(app.handle().clone());

            let permission: tauri::State<'_, Arc<permission::PermissionState>> = app.state();
            let manager: tauri::State<'_, Arc<chats::ChatManager>> = app.state();
            manager.init(app.handle().clone(), Arc::clone(&permission));
            // Fixed path, not pid-derived: the socket is baked into each child's
            // --mcp-config, so it has to be stable for the app's lifetime.
            let socket = chats::runtime_dir().join("permission.sock");
            let handle = app.handle().clone();
            let owner = Arc::clone(&manager);
            permission::start_bridge(
                Arc::clone(&permission),
                socket,
                move |request| {
                    let _ = handle.emit(permission::EVENT_REQUEST, request);
                },
                // Asks for a chat this process does not hold belong to a
                // previous run's survivors; the bridge denies those rather than
                // parking them on a prompt no window will show.
                move |chat_id| owner.statuses().iter().any(|status| status.chat_id == chat_id),
            )?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // selection + clipboard
            primary::primary_get,
            primary::primary_set,
            primary::clipboard_get,
            primary::clipboard_set,
            primary::clipboard_image,
            // sessions sidebar
            sessions::list_sessions,
            sessions::read_session_transcript,
            sessions::search_sessions,
            chats::rename_session,
            chats::expand_search_terms,
            // chat transport
            claude::claude_start,
            claude::claude_restart,
            claude::claude_send,
            claude::claude_send_raw,
            claude::claude_interrupt,
            claude::claude_detach,
            claude::claude_kill,
            claude::claude_status,
            // terminal
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            pty::pty_list,
            // files
            workspace::list_dir,
            workspace::discover_repos,
            workspace::search_files,
            workspace::read_text_file,
            workspace::read_text_file_meta,
            workspace::write_text_file,
            workspace::home_dir,
            // git
            git::git_log,
            git::git_status,
            git::git_show,
            git::git_diff_file,
            git::git_branches,
            git::git_root,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_discard,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_branch_list,
            git::git_checkout,
            git::git_create_branch,
            git::git_merge,
            // usage
            usage::fetch_usage,
            // dashboard statistics
            stats::stats_summary,
            // tool permissions
            claude::permission_respond,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // The whole point of owning children in-process: when the window is
            // gone, so is every `claude` it started. Killing on Exit rather than
            // ExitRequested means a window closed by the WM is covered too.
            if matches!(event, tauri::RunEvent::Exit) {
                let manager: tauri::State<'_, Arc<chats::ChatManager>> = app.state();
                manager.kill_all();
            }
        });
}
