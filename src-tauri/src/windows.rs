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

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Window};

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

/// The lowest free label, given the ones already taken.
///
/// Lowest rather than next-highest so labels are reused: the stored layout for
/// `window-2` comes back when a second window does, the way reopening the app
/// brings back `main`'s. A gap left by a closed window is the whole point.
fn next_label(taken: &[String]) -> String {
    let mut n = 2;
    while taken.iter().any(|label| label == &format!("{LABEL_PREFIX}{n}")) {
        n += 1;
    }
    format!("{LABEL_PREFIX}{n}")
}

/// Open another window onto this process.
///
/// Sync on purpose: window creation is main-loop work on every platform this
/// targets, and it is bounded — there is nothing here to park on.
#[tauri::command]
pub fn open_window(app: AppHandle, window: Window) -> Result<String, String> {
    let taken: Vec<String> = app.webview_windows().keys().cloned().collect();
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

    /// The reuse that makes a returning window find its own stored layout.
    #[test]
    fn fills_the_gap_a_closed_window_left() {
        let taken = vec!["main".to_string(), "window-3".to_string()];
        assert_eq!(next_label(&taken), "window-2");
    }
}
