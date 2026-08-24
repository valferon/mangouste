//! The PATH a windowed launch does not inherit.
//!
//! A shell hands its child everything it exported; Finder and Dock hand a bundle
//! `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. So on macOS every tool the
//! user installed the way macOS tools are installed — Homebrew, nvm, bun, volta,
//! a `~/.local/bin` — is invisible to a double-clicked app while being on the
//! PATH of every terminal on the machine. `claude` is the one that matters here,
//! and it is worse than a missing binary: the CLI is a node script, so an app
//! that finds `claude` by absolute path still fails when its `#!/usr/bin/env
//! node` cannot resolve `node`.
//!
//! The fix every GUI editor ends up at: ask the user's login shell what its PATH
//! is, once, and hand that to every child we spawn.
//!
//! Linux keeps whatever PATH it inherited — a `.desktop` launch already gets the
//! session environment, and rewriting it there would only add a way to be wrong.
//! `probe_login_path` and the candidate list therefore compile everywhere but are
//! reached only on macOS, so a typo in them is a build error on either host.

use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

/// Wraps the probed value so shell noise — an interactive rc file that greets, a
/// job-control warning from a shell with no terminal — cannot be mistaken for a
/// PATH.
const MARKER: &str = "__mangouste_path__";

/// How long the login shell gets to answer.
///
/// Long enough for a heavy `.zshrc` (nvm, rbenv, a prompt framework), short
/// enough that a wedged one costs a pause rather than the session. The abandoned
/// thread is left to finish on its own; nothing waits on it again.
const PROBE_TIMEOUT: Duration = Duration::from_secs(6);

/// The user's shell, for a pty and for the PATH probe both.
///
/// `$SHELL` is set for anything started from a terminal, and on macOS is also
/// what a windowed launch usually inherits — but not reliably: launchd populates
/// that environment from the user record, and an app opened from Finder can
/// arrive without it. So the account's own `UserShell` is asked next, which is
/// where `$SHELL` came from in the first place, and only then a default. The
/// default matters: `/bin/bash` on macOS is bash 3.2 from 2007, and it is not
/// the shell of anyone whose dotfiles are zsh's.
pub fn user_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() {
            return shell;
        }
    }
    if cfg!(target_os = "macos") {
        if let Some(shell) = account_shell() {
            return shell;
        }
        return "/bin/zsh".to_string();
    }
    "/bin/bash".to_string()
}

/// `UserShell` out of the local directory service. macOS only.
fn account_shell() -> Option<String> {
    let user = std::env::var("USER").ok().filter(|u| !u.is_empty())?;
    let output = Command::new("dscl")
        .args([".", "-read", &format!("/Users/{user}"), "UserShell"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // "UserShell: /bin/zsh"
    let text = String::from_utf8_lossy(&output.stdout);
    let shell = text.split_once(':')?.1.trim().to_string();
    let usable = !shell.is_empty()
        && shell.starts_with('/')
        && std::path::Path::new(&shell).is_file();
    usable.then_some(shell)
}

/// Ask the login shell for the PATH an interactive session would have.
///
/// `-ilc`, not `-lc`: zsh only reads `.zshrc` when interactive, and `.zshrc` is
/// where Homebrew's own installer and every version manager tell people to put
/// their PATH. The cost is that the shell may print a banner or complain about
/// the missing terminal, which is what `MARKER` is for.
fn probe_login_path() -> Option<String> {
    let shell = user_shell();
    let script = format!("printf '{MARKER}%s{MARKER}' \"$PATH\"");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(Command::new(&shell).args(["-ilc", &script]).output());
    });
    let output = rx.recv_timeout(PROBE_TIMEOUT).ok()?.ok()?;
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let path = text.split(MARKER).nth(1)?.trim().to_string();
    (!path.is_empty()).then_some(path)
}

/// Where macOS package managers put their bins, for when the probe comes back
/// empty — a login shell that failed to run, or a `$SHELL` that is not a shell.
///
/// Homebrew first because its `/opt/homebrew` prefix is Apple Silicon's and is on
/// no default PATH at all.
fn fallback_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".bun/bin"));
        dirs.push(home.join(".volta/bin"));
        dirs.push(home.join(".cargo/bin"));
    }
    dirs
}

/// The PATH children should get, or None to leave the inherited one alone.
///
/// Computed once. The probe spawns a shell, so this must not run on the main
/// thread; every caller is inside a `#[tauri::command(async)]` or a worker
/// thread already.
pub fn child_path() -> Option<&'static String> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            if !cfg!(target_os = "macos") {
                return None;
            }
            let inherited = std::env::var("PATH").unwrap_or_default();
            let mut entries: Vec<String> = Vec::new();
            let mut push = |entry: &str| {
                if entry.is_empty() || entries.iter().any(|seen| seen == entry) {
                    return;
                }
                entries.push(entry.to_string());
            };
            // The login shell's own answer leads: it is the PATH the user
            // actually has, in the order they meant.
            if let Some(probed) = probe_login_path() {
                for entry in probed.split(':') {
                    push(entry);
                }
            }
            for dir in fallback_dirs() {
                if dir.is_dir() {
                    push(&dir.to_string_lossy());
                }
            }
            for entry in inherited.split(':') {
                push(entry);
            }
            let joined = entries.join(":");
            // Nothing new to say: an unchanged PATH is better left unset, so a
            // child sees the environment it would have inherited.
            (joined != inherited).then_some(joined)
        })
        .as_ref()
}

/// Give `command` the user's PATH, if we found a better one than ours.
pub fn with_child_path(command: &mut Command) -> &mut Command {
    if let Some(path) = child_path() {
        command.env("PATH", path);
    }
    command
}

/// Directories to look in for a bare tool name, in the order `child_path` would
/// search them. Used to resolve a binary by hand when the PATH we would hand a
/// child is not the PATH we ourselves have.
pub fn child_path_dirs() -> Vec<PathBuf> {
    match child_path() {
        Some(path) => path.split(':').map(PathBuf::from).collect(),
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// On Linux the whole mechanism stands down, and children keep the session
    /// PATH they would have inherited. Asserted rather than assumed: silently
    /// rewriting PATH on the platform that already had a correct one is the one
    /// way this file could do harm.
    #[test]
    #[cfg(not(target_os = "macos"))]
    fn leaves_the_inherited_path_alone_off_macos() {
        assert!(child_path().is_none());
        assert!(child_path_dirs().is_empty());
    }

    /// Whatever else it is, the shell has to be an absolute path — a pty spawns
    /// it directly, with no PATH lookup behind it.
    #[test]
    fn resolves_an_absolute_shell() {
        let shell = user_shell();
        assert!(shell.starts_with('/'), "not a path: {shell}");
    }

    /// The probe must survive a shell that talks over it.
    #[test]
    fn marker_parsing_ignores_surrounding_noise() {
        let text = format!("zsh: no job control\n{MARKER}/opt/homebrew/bin:/usr/bin{MARKER}");
        assert_eq!(
            text.split(MARKER).nth(1).map(str::trim),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }
}
