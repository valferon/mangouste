mod chats;
mod claude;
mod env;
mod format;
mod git;
mod primary;
mod permission;
mod pty;
mod search;
mod sessions;
mod stats;
mod usage;
mod windows;
mod workspace;

use std::sync::Arc;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_full::new_debouncer;
use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, WindowEvent, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

// The label `tauri.conf.json` declares. Looked up by name rather than as "the
// first window", so the one shown at the end of `setup` is that window and not
// whichever second window `windows::open_window` has since minted.
use windows::MAIN_WINDOW;

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

/// The macOS menu bar.
///
/// macOS needs a real menu for reasons that have nothing to do with menus: a
/// WKWebView gets ⌘C/⌘V/⌘Z from the Edit menu's items, not from the webview, so
/// an app without one cannot copy or paste at all. Tauri knows this and installs
/// a default menu when none is set — but its File and Window submenus both carry
/// Close Window, so ⌘W closes the only window there is, and closing that window
/// kills every `claude` this process owns. On a workbench whose whole premise is
/// unattended sessions, a reflex keystroke from the browser must not end eight
/// of them.
///
/// So the default is replaced by this: the same editing and window items, no
/// Close Window, and ⌘W left to the frontend — where it closes a tab, which is
/// what it does in the editors this borrows its keymap from.
///
/// Quit is kept, and stays the way out: `RunEvent::Exit` still reaps the
/// children. Compiled on every platform so it typechecks off macOS, installed
/// only there — Linux and Windows draw the menu bar inside the window.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mac_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    trace("building the macOS menu");
    let package = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|publisher| vec![publisher]),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        &package.name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // The whole reason a menu exists here. The items are the AppKit responders,
    // so they reach the webview's own selection rather than going through the
    // clipboard commands in `primary.rs`.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu]);
    trace("macOS menu built");
    menu
}

/// Startup breadcrumbs, for the launch that draws nothing.
///
/// A windowed app that hangs before its window appears is opaque from the
/// outside: the window is configured hidden and shown at the end of `setup`, so
/// "no window" covers everything from a wedged phase in here to a process that
/// never reached `main` at all. Whether any of these lines appear, and which is
/// last, is the difference between those two — and on macOS it is the only
/// signal available, since a hardened-runtime binary cannot be sampled.
///
/// Off unless asked for: `MANGOUSTE_TRACE_STARTUP=1`, and stderr, so a launch
/// from a terminal shows it and a launch from a launcher does not care.
fn trace(phase: &str) {
    if std::env::var_os("MANGOUSTE_TRACE_STARTUP").is_some() {
        eprintln!("mangouste: {phase}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    trace("run");
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(chats::ChatManager::default()))
        .manage(Arc::new(permission::PermissionState::default()))
        .manage(pty::PtyState::default())
        .manage(sessions::SessionCache::default())
        .manage(stats::StatsCache::default())
        .setup(|app| {
            trace("setup");
            watch_sessions(app.handle().clone());
            trace("session watcher started");
            // Warm the login-shell PATH probe off the main thread: the first
            // chat start is a synchronous command, and on macOS resolving that
            // PATH means running the user's shell. Nothing waits on this — a
            // caller that arrives first blocks on the same cache.
            std::thread::spawn(|| {
                let _ = env::child_path();
            });
            trace("path probe spawned");

            let permission: tauri::State<'_, Arc<permission::PermissionState>> = app.state();
            let manager: tauri::State<'_, Arc<chats::ChatManager>> = app.state();
            manager.init(app.handle().clone(), Arc::clone(&permission));
            // Fixed path, not pid-derived: the socket is baked into each child's
            // --mcp-config, so it has to be stable for the app's lifetime.
            let socket = chats::runtime_dir().join("permission.sock");
            trace(&format!("runtime dir resolved ({})", socket.display()));
            let handle = app.handle().clone();
            let owner = Arc::clone(&manager);
            // Raising the window is what a second launch of a single-instance
            // app is asking for, so the running instance answers `show` by
            // doing exactly that. `unminimize` first: `set_focus` alone leaves
            // an iconified window iconified.
            let raiser = app.handle().clone();
            let started = permission::start_bridge(
                Arc::clone(&permission),
                socket,
                move |request| {
                    let _ = handle.emit(permission::EVENT_REQUEST, request);
                },
                // Asks for a chat this process does not hold belong to a
                // previous run's survivors; the bridge denies those rather than
                // parking them on a prompt no window will show.
                move |chat_id| owner.statuses().iter().any(|status| status.chat_id == chat_id),
                move || {
                    // Main by preference, but any window will do: with a second
                    // one open, main is no longer guaranteed to be the survivor.
                    let window = raiser.get_webview_window(MAIN_WINDOW).or_else(|| {
                        raiser.webview_windows().into_values().next()
                    });
                    if let Some(window) = window {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                },
            );

            trace("permission bridge settled");

            if let Err(collision) = started {
                // The running instance took the launch: it is now in front, and
                // there is nothing to tell anyone.
                if collision.raised {
                    std::process::exit(0);
                }
                // It holds the socket but would not answer — a build too old to
                // know `show`, or one wedged mid-prompt. This is the case that
                // used to be a panic onto a stderr nobody reads, so it gets the
                // one thing a double-clicked launcher can show: a dialog. Exit
                // runs from its callback, because a blocking dialog on the main
                // thread during `setup` deadlocks the loop that would draw it.
                app.dialog()
                    .message(format!(
                        "The running window owns the permission bridge at {}.\n\n                         A second instance would compete with it for tool prompts, \
                         so this one will not start. Close the other window first.",
                        collision.socket.display()
                    ))
                    .title("mangouste is already running")
                    .kind(MessageDialogKind::Warning)
                    .show(|_| std::process::exit(0));
                return Ok(());
            }

            // Only now is this instance the real one. The window is configured
            // hidden so neither branch above can flash an empty frame — which is
            // exactly what the old panic did.
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let _ = window.show();
            }
            trace("window shown");
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
            format::format_text,
            // find and replace across the repo
            search::search_text,
            search::replace_matches,
            // git
            git::git_log,
            git::git_status,
            git::git_tracking,
            git::git_dirty,
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
            // windows
            windows::open_window,
            // usage
            usage::fetch_usage,
            // dashboard statistics
            stats::stats_summary,
            // tool permissions
            claude::permission_respond,
        ]);

    // Every window takes its own children with it. The process-wide sweep on
    // `RunEvent::Exit` below still catches the last one, but with more than one
    // window open that sweep is far too late: a closed window's shells would go
    // on running invisibly, and its chats would raise permission prompts at a
    // pane that no longer exists.
    //
    // `Destroyed`, not `CloseRequested`: a close request can be vetoed, and
    // reaping a window's children before it is actually gone would empty a
    // window that stayed. Off the main thread, because both sweeps wait out a
    // grace period per child and this runs while the other window is drawing.
    let builder = builder.on_window_event(|window, event| {
        if !matches!(event, WindowEvent::Destroyed) {
            return;
        }
        let handle = window.app_handle().clone();
        let label = window.label().to_string();
        std::thread::spawn(move || {
            let terminals: tauri::State<'_, pty::PtyState> = handle.state();
            pty::close_owned_by(&terminals, &label);
            let manager: tauri::State<'_, Arc<chats::ChatManager>> = handle.state();
            manager.kill_owned_by(&label);
        });
    });

    // Only macOS gets a native menu; the other platforms draw the menu bar
    // inside the window, and a second one above it would be a duplicate.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(mac_menu);

    trace("building the app");
    builder
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
