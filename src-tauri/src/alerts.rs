//! Telling someone a session changed, when nobody is looking at the rail.
//!
//! The rail already knows every session's status to the second. What it cannot
//! do is reach past the window: a session that goes `awaiting` while you are in
//! another app is exactly the case the whole workbench exists for, and today it
//! waits silently until you look. This module is the other half — the *edge*
//! rather than the state.
//!
//! The edge is free. `list_sessions` already captures `previous_status` before
//! it re-parses a transcript, because `apply_downgrade_grace` needs to know what
//! a session read as a moment ago; a transition is that value against the
//! settled one, two lines apart. Reading it there rather than in a scan of its
//! own also means it is post-grace, so the turn-boundary flicker the grace
//! exists to absorb never reaches a notification.
//!
//! It is deduplicated for free too. The session cache is process-wide `State`
//! and both windows call the same `list_sessions`, so whichever scan lands first
//! consumes the edge and the second sees `previous == settled`. Nothing here has
//! to know how many windows are open.
//!
//! Two consumers, and the split between them is deliberate:
//!
//!   * **Hooks run here**, in Rust, because a hook must fire whether or not a
//!     window has focus — that is the point of a hook.
//!   * **Notifications are decided in the frontend**, which is the only place
//!     that knows whether you are already looking at the session in question.
//!     This module emits `sessions://transition` and `post_notification` is what
//!     comes back.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

pub const EVENT_TRANSITION: &str = "sessions://transition";

/// Statuses worth interrupting someone over.
///
/// `active` is missing because the overwhelmingly common way a session becomes
/// active is that you just typed into it, and `idle` because it reports the
/// clock rather than an outcome — nothing happened, something merely stopped
/// having happened recently. What is left is the three that owe you something:
/// a question, a finished turn, or a turn that was cut off.
const NOTABLE: [&str; 3] = ["awaiting", "finished", "interrupted"];

/// How long a hook may run before its process group is killed.
///
/// Generous, because a hook that posts to a chat server is a normal hook and a
/// cold TLS handshake is not fast. Bounded at all, because these are spawned
/// from a scan that runs every fifteen seconds and a wedged hook would otherwise
/// accumulate one stuck child per tick for the life of the app.
const HOOK_TIMEOUT: Duration = Duration::from_secs(30);

/// One session crossing from one status to another.
///
/// Carries the session's identity rather than a rendered sentence: the frontend
/// wants to look the row up and decide, and a hook wants the fields in its
/// environment. Neither wants a string somebody else formatted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub session_id: String,
    pub file: String,
    pub cwd: String,
    pub title: Option<String>,
    pub from: String,
    pub to: String,
}

/// Whether a status change is worth telling anyone about.
///
/// `from` is `None` for a transcript this process has not scanned before, and
/// that case is emphatically not a transition: on a cold start every session on
/// the machine arrives that way, and a first launch that fires a notification
/// for every question you left unanswered last month is a first launch nobody
/// leaves switched on.
pub fn is_notable(from: Option<&str>, to: &str) -> bool {
    match from {
        None => false,
        Some(previous) => previous != to && NOTABLE.contains(&to),
    }
}

/* ---------- hooks ---------- */

/// One entry in the hooks file.
///
/// `run` is handed to `sh -c` unchanged, and everything about the session
/// arrives in the environment instead. That split is not a style choice — see
/// `spawn_hook`.
#[derive(Debug, Clone, Deserialize)]
pub struct Hook {
    /// Statuses this hook answers to. Absent or `["*"]` means all of them.
    #[serde(default)]
    pub on: Vec<String>,
    pub run: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct HookFile {
    #[serde(default)]
    hooks: Vec<Hook>,
}

/// Whether a hook answers to a transition into `to`.
pub fn hook_matches(hook: &Hook, to: &str) -> bool {
    hook.on.is_empty() || hook.on.iter().any(|entry| entry == "*" || entry == to)
}

/// Where the hooks file lives.
///
/// Under the user's config directory and nowhere else. Deliberately *not* a
/// per-repo file: this is a list of shell commands, and a repo-local one would
/// mean cloning a repository and opening it here was enough to run its author's
/// commands on your machine.
pub fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("mangouste").join("hooks.json"))
}

/// Parsed hooks, and the mtime they were parsed at.
static CACHE: OnceLock<Mutex<(u64, Vec<Hook>)>> = OnceLock::new();

/// The hooks a file's text declares.
///
/// Anything unparseable is no hooks rather than an error: this is read from a
/// scan that runs every fifteen seconds, and a typo in a config file must not
/// be able to stop the sidebar from working.
fn parse_hooks(text: &str) -> Vec<Hook> {
    serde_json::from_str::<HookFile>(text)
        .map(|file| file.hooks)
        .unwrap_or_default()
}

/// The hooks as the file currently reads.
///
/// Re-read when the file's mtime moves, so editing it takes effect on the next
/// scan rather than at the next launch. A file that is missing, unreadable or
/// malformed is an empty list: a typo in a config file must not be able to stop
/// the sidebar from scanning.
fn load() -> Vec<Hook> {
    let Some(path) = config_path() else {
        return Vec::new();
    };
    let mtime = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let cache = CACHE.get_or_init(|| Mutex::new((u64::MAX, Vec::new())));
    let mut held = cache.lock();
    if held.0 == mtime {
        return held.1.clone();
    }

    let parsed = std::fs::read_to_string(&path)
        .map(|text| parse_hooks(&text))
        .unwrap_or_default();
    *held = (mtime, parsed.clone());
    parsed
}

/// Run one hook for one transition, without waiting for it.
///
/// **Nothing about the session is interpolated into the command string.** Titles
/// and prompts come out of transcripts, which are full of model output and tool
/// output — text this app has no say in. Formatting any of it into a string
/// bound for `sh -c` would be a command-injection path from anything Claude ever
/// read. The environment carries it instead, where a shell never re-parses it.
///
/// Its own process group, like every other child here, so the timeout can signal
/// the whole subtree rather than the `sh` at its root.
fn spawn_hook(hook: &Hook, transition: &Transition) {
    let run = hook.run.clone();
    let transition = transition.clone();
    std::thread::spawn(move || {
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(&run)
            .env("MANGOUSTE_SESSION_ID", &transition.session_id)
            .env("MANGOUSTE_SESSION_FILE", &transition.file)
            .env("MANGOUSTE_SESSION_CWD", &transition.cwd)
            .env(
                "MANGOUSTE_SESSION_TITLE",
                transition.title.as_deref().unwrap_or(""),
            )
            .env("MANGOUSTE_FROM", &transition.from)
            .env("MANGOUSTE_TO", &transition.to)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }

        let Ok(mut child) = command.spawn() else {
            return;
        };
        let pid = child.id() as i32;
        let deadline = Instant::now() + HOOK_TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        #[cfg(unix)]
                        unsafe {
                            libc::kill(-pid, libc::SIGKILL);
                        }
                        let _ = child.kill();
                        let _ = child.wait();
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(_) => return,
            }
        }
    });
}

/* ---------- delivery ---------- */

/// The one window a transition is announced to.
///
/// One, not all: two windows are two webviews onto the same backend, and
/// broadcasting would mean two notifications for one event. The focused window
/// by preference, because it is the only one that can honestly answer "are you
/// already looking at this session" — falling back to main, and then to whatever
/// is open, since with a second window up main is no longer guaranteed to be the
/// survivor.
fn alert_window(app: &AppHandle) -> Option<WebviewWindow> {
    let windows = app.webview_windows();
    if let Some(focused) = windows.values().find(|w| w.is_focused().unwrap_or(false)) {
        return Some(focused.clone());
    }
    if let Some(main) = windows.get(crate::windows::MAIN_WINDOW) {
        return Some(main.clone());
    }
    let mut labels: Vec<&String> = windows.keys().collect();
    labels.sort();
    labels
        .first()
        .and_then(|label| windows.get(label.as_str()).cloned())
}

/// Announce a scan's transitions: hooks first, then the window.
///
/// Hooks first because they are the half that does not depend on anyone being
/// there. Both are fire-and-forget — this is called from the scan, and a scan
/// must not wait on a notification daemon or on somebody's shell script.
pub fn dispatch(app: &AppHandle, transitions: &[Transition]) {
    if transitions.is_empty() {
        return;
    }

    let hooks = load();
    for transition in transitions {
        for hook in hooks
            .iter()
            .filter(|hook| hook_matches(hook, &transition.to))
        {
            spawn_hook(hook, transition);
        }
    }

    if let Some(window) = alert_window(app) {
        for transition in transitions {
            let _ = window.emit(EVENT_TRANSITION, transition);
        }
    }
}

/// Raise a desktop notification.
///
/// The frontend's half of the split: it holds the preferences and knows which
/// session is on screen, so it decides, and this only delivers. A failure is
/// reported rather than swallowed — a desktop with no notification daemon should
/// show up in the debug log rather than as a setting that quietly does nothing.
#[tauri::command]
pub fn post_notification(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_first_sighting_is_not_a_transition() {
        // The cold-start case: every transcript on the machine arrives with no
        // previous status, and none of them just happened.
        assert!(!is_notable(None, "awaiting"));
        assert!(!is_notable(None, "interrupted"));
    }

    #[test]
    fn standing_still_is_not_a_transition() {
        assert!(!is_notable(Some("awaiting"), "awaiting"));
    }

    #[test]
    fn the_three_that_owe_you_something() {
        assert!(is_notable(Some("active"), "awaiting"));
        assert!(is_notable(Some("active"), "finished"));
        assert!(is_notable(Some("active"), "interrupted"));
    }

    #[test]
    fn typing_into_a_session_is_not_news() {
        // You are the one who made it active, and `idle` is the clock talking.
        assert!(!is_notable(Some("finished"), "active"));
        assert!(!is_notable(Some("finished"), "idle"));
    }

    #[test]
    fn a_hook_with_no_filter_answers_to_everything() {
        let hook = Hook {
            on: Vec::new(),
            run: "true".into(),
        };
        assert!(hook_matches(&hook, "awaiting"));
        assert!(hook_matches(&hook, "finished"));
    }

    #[test]
    fn a_star_is_the_explicit_spelling_of_the_same_thing() {
        let hook = Hook {
            on: vec!["*".into()],
            run: "true".into(),
        };
        assert!(hook_matches(&hook, "interrupted"));
    }

    #[test]
    fn a_filtered_hook_answers_only_to_its_own_statuses() {
        let hook = Hook {
            on: vec!["awaiting".into(), "interrupted".into()],
            run: "true".into(),
        };
        assert!(hook_matches(&hook, "awaiting"));
        assert!(hook_matches(&hook, "interrupted"));
        assert!(!hook_matches(&hook, "finished"));
    }

    #[test]
    fn a_malformed_hooks_file_yields_no_hooks_rather_than_an_error() {
        // The scan runs every fifteen seconds; a typo must not stop it.
        assert!(parse_hooks("{ not json ]").is_empty());
        assert!(parse_hooks("").is_empty());
        assert!(parse_hooks("{}").is_empty());
    }

    #[test]
    fn an_absent_on_field_parses_as_no_filter() {
        let hooks = parse_hooks(r#"{"hooks":[{"run":"notify-send hi"}]}"#);
        assert_eq!(hooks.len(), 1);
        assert!(hooks[0].on.is_empty());
        assert!(hook_matches(&hooks[0], "finished"));
    }

    /// The example in the README, verbatim. If this stops parsing, the docs are
    /// telling people to write a file that does nothing.
    #[test]
    fn the_documented_example_parses() {
        let hooks = parse_hooks(
            r#"{
  "hooks": [
    { "on": ["awaiting", "interrupted"], "run": "say \"$MANGOUSTE_SESSION_TITLE needs you\"" },
    { "run": "logger -t mangouste \"$MANGOUSTE_SESSION_ID $MANGOUSTE_FROM -> $MANGOUSTE_TO\"" }
  ]
}"#,
        );
        assert_eq!(hooks.len(), 2);
        assert!(hook_matches(&hooks[0], "awaiting"));
        assert!(!hook_matches(&hooks[0], "finished"));
        assert!(hook_matches(&hooks[1], "finished"));
    }
}
