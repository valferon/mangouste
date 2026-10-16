//! A second workbench window, in the same process.
//!
//! Not a second *instance*: the permission bridge is a single socket this
//! process owns, so a second launch is still refused by the dialog in `lib.rs`.
//! What this opens is another webview onto the same backend — the same chat
//! manager, the same terminals, the same session cache — which is what makes it
//! cheap. Two windows watching the same `~/.claude/projects` cost one watcher.
//!
//! The frontend is what makes them separate workbenches: it scopes its stored
//! layout, its chat ids and its terminal ids by the window label handed out
//! here (see `src/lib/windowScope.ts`), so two windows do not fight over one
//! tab strip or open a shell on top of each other's.
//!
//! Ownership runs the other way too. Children live and die with the window that
//! started them — the promise `chats.rs` has always made, now made per window
//! rather than per process, since a window that goes away can no longer answer
//! a permission prompt for the chats it raised.

use std::collections::HashSet;

use parking_lot::Mutex;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, Window};

/// Label of the window `tauri.conf.json` declares. Every other one is minted.
pub const MAIN_WINDOW: &str = "main";

/// Prefix for minted labels. Parsed back in `next_label`, so it is not cosmetic:
/// the number in it is what makes a reopened window reuse a departed one's
/// stored layout instead of leaving orphan keys in `localStorage` forever.
const LABEL_PREFIX: &str = "window-";

/// Offset of a new window from the one that asked for it, in logical pixels.
/// Enough that the title bar of the window underneath stays grabbable.
const CASCADE: f64 = 36.0;

/// Fallback size, used only when the asking window will not report its own.
const DEFAULT_SIZE: (f64, f64) = (1600.0, 1000.0);

/// Labels of windows that are gone but whose children are still being reaped.
///
/// Ownership is recorded as the bare label, so a label handed out again before
/// its old window's sweep finished would be the same owner to `chats.rs` and
/// `pty.rs`: the new window would attach to the dying window's chats, and the
/// sweep would then kill the new window's own. Holding the label back until the
/// sweep is done keeps the two apart; `window-3` is a fine name meanwhile.
#[derive(Default)]
pub struct Reaping(Mutex<HashSet<String>>);

impl Reaping {
    /// Hold `label` back. Called from `Destroyed`, before the sweep starts.
    pub fn begin(&self, label: &str) {
        self.0.lock().insert(label.to_string());
    }

    /// Release `label` once its children are gone.
    pub fn end(&self, label: &str) {
        self.0.lock().remove(label);
    }

    fn labels(&self) -> Vec<String> {
        self.0.lock().iter().cloned().collect()
    }
}

/// The lowest free label, given the ones already taken.
///
/// Lowest rather than next-highest so labels are reused: the stored layout for
/// `window-2` comes back when a second window does, the way reopening the app
/// brings back `main`'s. A gap left by a closed window is the whole point.
fn next_label(taken: &[String]) -> String {
    let mut n = 2;
    while taken
        .iter()
        .any(|label| label == &format!("{LABEL_PREFIX}{n}"))
    {
        n += 1;
    }
    format!("{LABEL_PREFIX}{n}")
}

/// How a window is named to the user: "window 2", counting `main` as the first.
///
/// Mirrors `windowName` in `src/lib/windowScope.ts`, and exists because the
/// backend has to name a window too — a refusal that said `window-2` would be
/// naming an internal label at somebody reading an error message.
pub fn window_name(label: &str) -> String {
    let number = label
        .strip_prefix(LABEL_PREFIX)
        .and_then(|n| n.parse::<u32>().ok())
        .filter(|n| *n > 1)
        .unwrap_or(1);
    format!("window {number}")
}

/// The window that takes control calls and runs the prompt schedule: `main`
/// while it is open, otherwise the lowest-numbered window still standing.
///
/// Not `main` outright: closing it with a second window open leaves the app
/// running, and with the role pinned to a label nothing can mint again, every
/// control call failed and no scheduled prompt fired until a restart.
pub fn control_window(labels: &[String]) -> Option<String> {
    labels
        .iter()
        .min_by_key(|label| window_number(label))
        .cloned()
}

/// A label's place in the order windows are counted in. One nobody minted
/// sorts last rather than ahead of the real ones.
fn window_number(label: &str) -> u32 {
    if label == MAIN_WINDOW {
        return 1;
    }
    label
        .strip_prefix(LABEL_PREFIX)
        .and_then(|n| n.parse::<u32>().ok())
        .unwrap_or(u32::MAX)
}

/// Windows able to take a control call: their listener is registered, and
/// they have not started closing.
///
/// Open is not enough on either end. A window `open_window` just built is in
/// the window map before its frontend has subscribed, and one past
/// `CloseRequested` is still in it until `Destroyed`; a call sent to either
/// reaches no listener and parks until the bridge's reply timeout.
#[derive(Default)]
pub struct ControlReady(Mutex<HashSet<String>>);

impl ControlReady {
    pub fn release(&self, label: &str) {
        self.0.lock().remove(label);
    }
}

/// The label of the window [`control_window`] picks among those ready now.
pub fn current_control_window(app: &AppHandle) -> Option<String> {
    let ready = app.state::<ControlReady>();
    let ready = ready.0.lock();
    let labels: Vec<String> = app
        .webview_windows()
        .into_keys()
        .filter(|label| ready.contains(label))
        .collect();
    control_window(&labels)
}

/// Called by a window once its control listener is up.
#[tauri::command]
pub fn claim_control(window: Window, ready: State<'_, ControlReady>) {
    ready.0.lock().insert(window.label().to_string());
}

/// Whether the asking window is the one that runs the prompt schedule.
///
/// Asked on every scheduler tick rather than once: the answer moves when the
/// window holding the role closes.
#[tauri::command]
pub fn is_control_window(app: AppHandle, window: Window) -> bool {
    current_control_window(&app).as_deref() == Some(window.label())
}

/// Global the new window's frontend reads its starting repo from. Mirrors
/// `REPO_GLOBAL` in `src/lib/windowScope.ts`.
const REPO_GLOBAL: &str = "__MANGOUSTE_OPEN_REPO__";

/// Script that hands a new window the repo it was opened for, before any of
/// the frontend runs.
///
/// An init script rather than a query string: the URL is the dev server's in
/// development and the bundled asset in a build, and only the script reaches
/// both the same way. The path goes through JSON so a quote or a backslash in
/// it is data, not script.
fn repo_script(repo: &str) -> String {
    let literal = serde_json::to_string(repo).unwrap_or_else(|_| "\"\"".to_string());
    format!("window.{REPO_GLOBAL} = {literal};")
}

/// Open another window onto this process, on `repo` when one is given.
///
/// Sync on purpose: window creation is main-loop work on every platform this
/// targets, and it is bounded — there is nothing here to park on.
#[tauri::command]
pub fn open_window(
    app: AppHandle,
    window: Window,
    reaping: State<'_, Reaping>,
    repo: Option<String>,
) -> Result<String, String> {
    let mut taken: Vec<String> = app.webview_windows().keys().cloned().collect();
    taken.extend(reaping.labels());
    let label = next_label(&taken);

    // Inherit the asking window's size, so a window opened from a tiled or
    // resized one does not come back at the configured default.
    let scale = window.scale_factor().unwrap_or(1.0);
    let (width, height) = window
        .inner_size()
        .map(|size| {
            let logical = size.to_logical::<f64>(scale);
            (logical.width, logical.height)
        })
        .unwrap_or(DEFAULT_SIZE);

    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::default())
        .title("mangouste")
        .inner_size(width, height)
        .min_inner_size(900.0, 600.0)
        .resizable(true);

    if let Some(repo) = repo.as_deref().filter(|r| !r.is_empty()) {
        builder = builder.initialization_script(repo_script(repo));
    }

    // Cascade off the asker rather than landing exactly on top of it. A failure
    // to read the position is not worth refusing the window over: let the window
    // manager place it instead.
    if let Ok(position) = window.outer_position() {
        let logical = position.to_logical::<f64>(scale);
        builder = builder.position(logical.x + CASCADE, logical.y + CASCADE);
    }

    let opened = builder.build().map_err(|e| e.to_string())?;
    let _ = opened.set_focus();
    Ok(label)
}

/// Raise an existing window by label.
///
/// The other half of session ownership: the rail in one window lists sessions
/// another window is running, and clicking one of those brings that window
/// forward rather than opening a second pane onto its process. Unminimised
/// first, since a window the user shrank is exactly the one they lost the
/// session in.
///
/// A label with no window behind it is an error rather than a silent no-op: the
/// caller asked for a window it believed was there, and swallowing that would
/// look like a click that did nothing.
#[tauri::command]
pub fn focus_window(app: AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no window `{label}`"))?;
    let _ = window.unminimize();
    window.set_focus().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_from_two_since_the_configured_window_is_main() {
        assert_eq!(next_label(&["main".to_string()]), "window-2");
    }

    #[test]
    fn skips_the_labels_already_open() {
        let taken = vec![
            "main".to_string(),
            "window-2".to_string(),
            "window-3".to_string(),
        ];
        assert_eq!(next_label(&taken), "window-4");
    }

    #[test]
    fn windows_are_named_as_a_person_counts_them() {
        assert_eq!(window_name(MAIN_WINDOW), "window 1");
        assert_eq!(window_name("window-2"), "window 2");
        // A label with no number behind it still has to name something.
        assert_eq!(window_name("window-"), "window 1");
    }

    #[test]
    fn a_label_still_being_reaped_is_not_handed_out() {
        let reaping = Reaping::default();
        reaping.begin("window-2");
        let mut taken = vec!["main".to_string()];
        taken.extend(reaping.labels());
        assert_eq!(next_label(&taken), "window-3");
        reaping.end("window-2");
        assert_eq!(next_label(&["main".to_string()]), "window-2");
    }

    #[test]
    fn a_repo_path_is_handed_over_as_a_string_literal() {
        assert_eq!(
            repo_script("/home/me/it's \"here\""),
            r#"window.__MANGOUSTE_OPEN_REPO__ = "/home/me/it's \"here\"";"#
        );
    }

    /// The reuse that makes a returning window find its own stored layout.
    #[test]
    fn fills_the_gap_a_closed_window_left() {
        let taken = vec!["main".to_string(), "window-3".to_string()];
        assert_eq!(next_label(&taken), "window-2");
    }

    #[test]
    fn control_passes_to_the_lowest_window_left_when_main_closes() {
        let labels = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        assert_eq!(
            control_window(&labels(&["window-2", "main"])).as_deref(),
            Some("main")
        );
        assert_eq!(
            control_window(&labels(&["window-10", "window-3"])).as_deref(),
            Some("window-3")
        );
        assert_eq!(control_window(&[]), None);
    }
}
