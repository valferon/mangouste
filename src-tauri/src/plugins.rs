//! Claude Code plugins, for the Settings panel.
//!
//! Everything goes through the `claude plugin` CLI with `--json` rather than
//! through the files under `~/.claude/plugins`. Those files are the CLI's own
//! state, written under its own locks and migrated between its versions; a
//! second writer here would be a second copy of rules that are not ours. The
//! CLI also does the parts that are not file edits at all: cloning
//! marketplaces, fetching archives, asking before a marketplace-declared
//! command runs.
//!
//! The panel names what to act on, so the arguments are checked before they
//! reach a command line: a fixed set of verbs, a fixed set of scopes, and a
//! target that cannot be read as a flag.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::chats::claude_binary;

/// Listing reads local state, plus the marketplace catalogs for `--available`.
const LIST_TIMEOUT_MS: u64 = 60_000;
/// Installs and marketplace adds clone repositories, which can be slow.
const ACTION_TIMEOUT_MS: u64 = 300_000;
/// Longest target accepted: plugin ids, marketplace names, URLs and paths.
const MAX_TARGET_CHARS: usize = 1024;
/// How much of a failed run's output is handed back as its message.
const MESSAGE_CHARS: usize = 600;

struct CliOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

/// Run `claude <args>` to completion or until `timeout_ms`.
///
/// Both pipes are drained on their own threads while the child runs. A
/// `list --available` prints a few megabytes of catalog, and a child blocked
/// on a full pipe never exits, so waiting first and reading after would hang
/// until the budget ran out.
///
/// The CLI runs in its own process group, and the group is what a timeout
/// kills: an install's `git clone`, or a command a marketplace declares, would
/// otherwise outlive it holding the plugin directory. The pipes are read
/// against the same deadline, since a grandchild that inherited them keeps
/// them open after `claude` itself has exited.
fn run_cli(args: &[String], cwd: Option<&str>, timeout_ms: u64) -> Result<CliOutput, String> {
    let dir = cwd
        .map(std::path::PathBuf::from)
        .filter(|dir| dir.is_dir())
        .or_else(dirs::home_dir)
        .ok_or("no directory to run claude in")?;
    let mut command = Command::new(claude_binary());
    crate::env::with_child_path(&mut command)
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("could not run claude: {e}"))?;
    let stdout = drain(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let stderr = drain(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let kill = |child: &mut std::process::Child| {
        #[cfg(unix)]
        // SAFETY: a plain syscall on the group this spawn created; the child
        // has not been reaped yet, so its pid (and so the group id) is still ours.
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
    };
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                kill(&mut child);
                return Err("claude did not finish in time".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => {
                kill(&mut child);
                return Err(e.to_string());
            }
        }
    };
    let remaining = || deadline.saturating_duration_since(Instant::now());
    Ok(CliOutput {
        success: status.success(),
        stdout: stdout.recv_timeout(remaining()).unwrap_or_default(),
        stderr: stderr.recv_timeout(remaining()).unwrap_or_default(),
    })
}

/// Read a pipe to its end on a thread, handing the text over a channel so the
/// caller can stop waiting for it.
fn drain(pipe: Option<Box<dyn Read + Send>>) -> std::sync::mpsc::Receiver<String> {
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        let _ = send.send(String::from_utf8_lossy(&bytes).into_owned());
    });
    receive
}

/// The tail of what a run printed, for a failure that carried no JSON.
fn message_of(output: &CliOutput) -> String {
    let text = if output.stderr.trim().is_empty() {
        output.stdout.trim()
    } else {
        output.stderr.trim()
    };
    let chars: Vec<char> = text.chars().collect();
    let start = chars.len().saturating_sub(MESSAGE_CHARS);
    chars[start..].iter().collect()
}

/// The last stdout line that parses as a JSON object: the CLI's result line.
fn result_line(stdout: &str) -> Option<Value> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .filter(|line| line.starts_with('{'))
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
}

fn check_scope(scope: Option<&str>) -> Result<(), String> {
    match scope {
        None | Some("user" | "project" | "local") => Ok(()),
        Some(other) => Err(format!("unknown scope {other:?}")),
    }
}

/// A plugin id, marketplace name, URL or path: never something the CLI could
/// read as an option, and never a control character.
fn check_target(target: &str) -> Result<(), String> {
    if target.trim().is_empty() {
        return Err("nothing named".into());
    }
    if target.starts_with('-') {
        return Err("a name cannot start with '-'".into());
    }
    if target.chars().count() > MAX_TARGET_CHARS || target.chars().any(char::is_control) {
        return Err("not a plugin or marketplace name".into());
    }
    Ok(())
}

/// The sha256 the CLI printed for a command it wants a person to approve.
fn check_accept(sha: &str) -> Result<(), String> {
    if sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("not a command fingerprint".into())
    }
}

/// The command line for one panel action, or why it is refused.
fn action_args(
    action: &str,
    target: &str,
    scope: Option<&str>,
    accept_command: Option<&str>,
) -> Result<Vec<String>, String> {
    check_scope(scope)?;
    // Updating every marketplace is the one action that names nothing, and the
    // CLI only prints a JSON result line when a marketplace is named.
    let everything = action == "marketplace-update" && target.is_empty();
    if !everything {
        check_target(target)?;
    }
    let mut args: Vec<String> = match action {
        "install" | "uninstall" | "update" | "enable" | "disable" => {
            vec!["plugin".into(), action.into()]
        }
        "marketplace-add" | "marketplace-remove" | "marketplace-update" => vec![
            "plugin".into(),
            "marketplace".into(),
            action.trim_start_matches("marketplace-").into(),
        ],
        other => return Err(format!("unknown plugin action {other:?}")),
    };
    if !everything {
        args.push(target.into());
        args.push("--json".into());
    }
    if let Some(scope) = scope {
        // `marketplace update` takes no scope; the others all do.
        if action != "marketplace-update" {
            args.extend(["--scope".into(), scope.into()]);
        }
    }
    if let Some(sha) = accept_command {
        if action != "install" && action != "update" {
            return Err("only an install or an update runs a command".into());
        }
        check_accept(sha)?;
        args.extend(["--accept-command".into(), sha.into()]);
    }
    Ok(args)
}

/// What an action did, as the panel shows it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRun {
    /// The CLI exited cleanly.
    pub ok: bool,
    /// Its result line, when it printed one.
    pub result: Option<Value>,
    /// What it said, for a run with no result line to read.
    pub message: String,
}

/// Installed plugins, and with `available` the marketplace catalogs too. `cwd`
/// is the repo whose project and local scopes count.
#[tauri::command(async)]
pub fn plugin_list(cwd: Option<String>, available: bool) -> Result<Value, String> {
    let mut args: Vec<String> = vec!["plugin".into(), "list".into(), "--json".into()];
    if available {
        args.push("--available".into());
    }
    let output = run_cli(&args, cwd.as_deref(), LIST_TIMEOUT_MS)?;
    if !output.success {
        return Err(message_of(&output));
    }
    serde_json::from_str(output.stdout.trim()).map_err(|e| format!("unreadable plugin list: {e}"))
}

/// The configured marketplaces.
#[tauri::command(async)]
pub fn plugin_marketplaces(cwd: Option<String>) -> Result<Value, String> {
    let args: Vec<String> = ["plugin", "marketplace", "list", "--json"]
        .map(String::from)
        .to_vec();
    let output = run_cli(&args, cwd.as_deref(), LIST_TIMEOUT_MS)?;
    if !output.success {
        return Err(message_of(&output));
    }
    serde_json::from_str(output.stdout.trim())
        .map_err(|e| format!("unreadable marketplace list: {e}"))
}

/// Install, uninstall, update, enable or disable a plugin, or add, remove or
/// update a marketplace. A failure the CLI reported is an `ok: false` run, not
/// an error, so its result line reaches the panel; `Err` is for a run that
/// never happened.
#[tauri::command(async)]
pub fn plugin_action(
    action: String,
    target: String,
    scope: Option<String>,
    cwd: Option<String>,
    accept_command: Option<String>,
) -> Result<PluginRun, String> {
    // Without a repo, `project` and `local` would land in whatever `.claude/`
    // the fallback directory has: the user's own, under a scope that says
    // otherwise.
    if matches!(scope.as_deref(), Some("project" | "local"))
        && !cwd
            .as_deref()
            .is_some_and(|dir| std::path::Path::new(dir).is_dir())
    {
        return Err("project and local scopes need a repo open".into());
    }
    let args = action_args(
        &action,
        target.trim(),
        scope.as_deref(),
        accept_command.as_deref(),
    )?;
    let output = run_cli(&args, cwd.as_deref(), ACTION_TIMEOUT_MS)?;
    Ok(PluginRun {
        ok: output.success,
        result: result_line(&output.stdout),
        message: message_of(&output),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(action: &str, target: &str, scope: Option<&str>) -> Result<Vec<String>, String> {
        action_args(action, target, scope, None)
    }

    #[test]
    fn plugin_verbs_build_their_command_lines() {
        assert_eq!(
            args("install", "caveman@caveman", Some("project")).unwrap(),
            [
                "plugin",
                "install",
                "caveman@caveman",
                "--json",
                "--scope",
                "project"
            ]
        );
        assert_eq!(
            args("disable", "x@y", None).unwrap(),
            ["plugin", "disable", "x@y", "--json"]
        );
        assert_eq!(
            args("marketplace-add", "owner/repo", Some("user")).unwrap(),
            [
                "plugin",
                "marketplace",
                "add",
                "owner/repo",
                "--json",
                "--scope",
                "user"
            ]
        );
    }

    #[test]
    fn updating_every_marketplace_names_nothing_and_prints_no_json() {
        assert_eq!(
            args("marketplace-update", "", None).unwrap(),
            ["plugin", "marketplace", "update"]
        );
        assert_eq!(
            args("marketplace-update", "caveman", Some("user")).unwrap(),
            ["plugin", "marketplace", "update", "caveman", "--json"]
        );
    }

    #[test]
    fn refuses_what_is_not_a_panel_action() {
        assert!(args("eval", "x@y", None).is_err());
        assert!(args("install", "--yes", None).is_err());
        assert!(args("install", "", None).is_err());
        assert!(args("install", "a\nb", None).is_err());
        assert!(args("install", "x@y", Some("managed")).is_err());
    }

    #[test]
    fn a_command_is_accepted_only_by_fingerprint_and_only_on_install_or_update() {
        let sha = "a".repeat(64);
        assert_eq!(
            action_args("install", "x@y", None, Some(&sha)).unwrap(),
            [
                "plugin",
                "install",
                "x@y",
                "--json",
                "--accept-command",
                sha.as_str()
            ]
        );
        assert!(action_args("install", "x@y", None, Some("abc")).is_err());
        assert!(action_args("enable", "x@y", None, Some(&sha)).is_err());
    }

    #[test]
    fn the_result_line_is_the_last_json_object_on_stdout() {
        let stdout = "Cloning…\n{\"outcome\":\"progress\"}\n{\"outcome\":\"ok\"}\n✔ done\n";
        assert_eq!(result_line(stdout).unwrap()["outcome"], "ok");
        assert!(result_line("✘ failed\n").is_none());
    }

    #[test]
    fn a_failure_message_prefers_stderr_and_keeps_its_end() {
        let output = CliOutput {
            success: false,
            stdout: "noise".into(),
            stderr: format!("{}tail", "x".repeat(MESSAGE_CHARS)),
        };
        let message = message_of(&output);
        assert_eq!(message.chars().count(), MESSAGE_CHARS);
        assert!(message.ends_with("tail"));
    }
}
