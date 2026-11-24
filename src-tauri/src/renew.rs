//! Renewing an account's stored sign-in without the person.
//!
//! A sign-in is two things with two lifetimes. The access token a request
//! carries lasts eight hours. The login behind it lasts weeks, and the CLI
//! trades it for a new token whenever it starts and finds the old one lapsed.
//! So an account nobody has used since yesterday holds an expired token and a
//! perfectly good login, and reading the first as "signed out" is what sent
//! people back through the browser after every switch.
//!
//! The renewal is the CLI's to do, not this app's. The refresh token is
//! single-use and rotates: two parties refreshing at once leave one of them
//! holding a dead token, and the CLI guards its own refreshes with a lock and
//! a compare-and-swap this process is no part of. So nothing here speaks
//! OAuth. It starts the CLI under the account with nothing to say: startup
//! fetches the organisation's settings and policy, which renews the token
//! first, and with stdin already at its end the process exits without a turn,
//! a transcript or a token spent. Measured on 2.1.322: under a second, exit 0,
//! no output, both fetches answered; and with a made-up lapsed login in a
//! scratch config dir, the refresh attempted before either of them.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

/// The client tag on a renewal, so it is told apart from a chat in the CLI's
/// own records.
const ENTRYPOINT_RENEW: &str = "mangouste-renew";

/// A start that takes no prompt and leaves nothing behind.
///
/// `stream-json` input is what lets `--print` start with no prompt at all: it
/// reads turns from stdin, finds none, and exits clean, where the text format
/// refuses to start. The output format has to match it, and `--verbose` is the
/// CLI's condition for that format. Safe mode keeps hooks, plugins and MCP
/// servers from starting for a process that will never run a turn; auth and
/// the organisation's managed settings, the part this is for, are untouched
/// by it. No session persistence, so not even an empty transcript.
const RENEW_ARGS: [&str; 8] = [
    "--print",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--safe-mode",
    "--no-session-persistence",
];

/// Variables that make the CLI authenticate some other way than the stored
/// login: a token or key handed in directly, or a switch to another provider.
/// Inherited from a shell that exports one, the renewal would start, use that
/// credential, and leave the stored token exactly as lapsed as it found it.
/// The names are the ones 2.1.322 reads.
const AUTH_OVERRIDES: [&str; 15] = [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "ANTHROPIC_IDENTITY_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_GATEWAY",
];

/// How long a renewal is waited on before it is asked to stop.
///
/// Longer than the thirty seconds the CLI gives its own refresh request, on
/// purpose. The refresh token is spent the moment the server answers, and a
/// CLI stopped between that answer and writing the new one to disk leaves the
/// account with a token that no longer works and no way to get another: the
/// one outcome worse than not renewing.
const RENEW_TIMEOUT: Duration = Duration::from_secs(60);

/// How long it is given to leave once asked. On SIGTERM the CLI shuts down
/// in order (a second, measured on 2.1.322), and its exit waits a few seconds
/// more for a refresh in flight; SIGKILL after this is for a process that is
/// not listening at all.
const STOP_GRACE: Duration = Duration::from_secs(10);

/// How long a run that left the token lapsed is remembered.
///
/// Long enough that the windows asking at the same moment share one run, and
/// no longer. A run that changes nothing is nearly always a machine with no
/// network yet (a laptop just woken), which must be tried again at the next
/// ask rather than remembered. A login that has really ended needs no memory
/// at all: the CLI blanks its tokens, the account reads as signed out, and no
/// renewal is asked for.
const FUTILE_FOR: Duration = Duration::from_secs(30);

/// When to ask again after a renewal that changed nothing: once the run is no
/// longer remembered. The usage window's own timer is minutes away, and a
/// laptop that woke without a network has one long before that.
pub const RETRY_AFTER_MS: u64 = (FUTILE_FOR.as_secs() + 5) * 1000;

/// What is kept of an account between renewals.
#[derive(Default)]
struct Slot {
    /// When the last run left the token lapsed, and how that run ended.
    futile: Option<(Instant, Result<(), String>)>,
}

type Slots = Mutex<HashMap<String, Arc<Mutex<Slot>>>>;

/// One slot per account, each with its own lock. A renewal holds its
/// account's for as long as the CLI runs, and one account waiting on a slow
/// network must not hold up the usage window of another.
fn slots() -> &'static Slots {
    static SLOTS: OnceLock<Slots> = OnceLock::new();
    SLOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn slot_of(slots: &Slots, name: &str) -> Arc<Mutex<Slot>> {
    slots.lock().entry(name.to_string()).or_default().clone()
}

/// Have the CLI renew `name`'s sign-in, while `lapsed` still says it needs it.
///
/// `lapsed` is asked again once the account's lock is held, and once more
/// after the run. Every window asks for the same account at the same moment
/// after a switch: the ones that waited find the work done and start nothing,
/// and when the run changed nothing they are told how it ended rather than
/// each repeating it. `Ok` says only that nothing went wrong running the CLI;
/// the caller reads the credentials again to learn whether it helped.
///
/// `lapsed` runs with the lock held. On macOS it is a keychain read, which
/// can wait on the system's own prompt; the callers it holds up are the ones
/// asking about this same account, who would each have raised that prompt.
pub fn renew(name: &str, lapsed: impl Fn() -> bool) -> Result<(), String> {
    let slot = slot_of(slots(), name);
    renew_in(&slot, lapsed, Instant::now, || run(name))
}

fn renew_in(
    slot: &Mutex<Slot>,
    lapsed: impl Fn() -> bool,
    now: impl Fn() -> Instant,
    run: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let mut state = slot.lock();
    if !lapsed() {
        return Ok(());
    }
    if let Some((at, outcome)) = &state.futile {
        if now().saturating_duration_since(*at) < FUTILE_FOR {
            return outcome.clone();
        }
    }
    let outcome = run();
    state.futile = lapsed().then(|| (now(), outcome.clone()));
    outcome
}

/// The renewal start for `name`, ready to spawn but for its PATH.
///
/// `said` takes whatever the CLI prints to stderr. A file rather than a pipe:
/// a pipe has to be drained while the child runs and is held open by anything
/// the child started, and the reader would then wait on a process that is not
/// the one being waited for.
///
/// In a process group of its own, as a chat is, so that stopping it reaches
/// whatever it started: `claude` can be a shim around the real binary.
fn command(binary: &str, name: &str, dir: &Path, said: Stdio) -> Command {
    let mut command = Command::new(binary);
    for variable in AUTH_OVERRIDES {
        command.env_remove(variable);
    }
    crate::account::apply_as(&mut command, name);
    command
        .args(RENEW_ARGS)
        .env("CLAUDE_CODE_ENTRYPOINT", ENTRYPOINT_RENEW)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(said)
        .process_group(0);
    command
}

/// Where a renewal runs and leaves what it said: a directory of this user's
/// alone. Not the shared temp dir the Haiku helpers use. A renewal writes a
/// file under a name anyone could guess, and in a directory another local
/// user got to first that name could be a link to a file of ours.
fn private_dir() -> Result<PathBuf, String> {
    use std::os::unix::fs::DirBuilderExt;
    let dir = crate::chats::runtime_dir().join("renew");
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)
        .map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Start the CLI under `name` with nothing on stdin, and wait for it to leave.
fn run(name: &str) -> Result<(), String> {
    let dir = private_dir()?;
    // Named by account and process: two accounts renew at once, and so do two
    // copies of the app.
    let said_path = dir.join(format!("renew-{name}-{}.err", std::process::id()));
    let said = private_file(&said_path);
    let stderr = match said.as_ref().map(|file| file.try_clone()) {
        Some(Ok(file)) => Stdio::from(file),
        _ => Stdio::null(),
    };
    let mut command = command(&crate::chats::claude_binary(), name, &dir, stderr);
    crate::env::with_child_path(&mut command);
    let outcome = command
        .spawn()
        .map_err(|e| format!("could not run claude: {e}"))
        .and_then(|child| finish(child, RENEW_TIMEOUT, STOP_GRACE));
    let detail = said.and_then(last_line);
    let _ = std::fs::remove_file(&said_path);
    outcome.map_err(|reason| match detail {
        Some(line) => format!("{reason}: {line}"),
        None => reason,
    })
}

/// A new file only this user can read, or `None` when it cannot be made.
///
/// Made, never opened: whatever already sits at the path is unlinked (a link
/// is taken away, not followed), and the create then refuses anything that
/// has appeared there since, link or file. A renewal that cannot have its
/// file runs without one and only loses the detail of how it failed.
fn private_file(path: &Path) -> Option<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    let _ = std::fs::remove_file(path);
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .ok()
}

/// How much of the end of stderr is looked at for its last line.
const SAID_TAIL: u64 = 4096;

/// How much of that line reaches the panel.
const SAID_MAX: usize = 200;

/// The last thing the CLI said, short enough to show.
fn last_line(mut said: std::fs::File) -> Option<String> {
    let len = said.metadata().ok()?.len();
    said.seek(SeekFrom::Start(len.saturating_sub(SAID_TAIL)))
        .ok()?;
    let mut tail = Vec::new();
    said.take(SAID_TAIL).read_to_end(&mut tail).ok()?;
    sayable(&String::from_utf8_lossy(&tail))
}

/// The last non-empty line of `text`, as something safe to put on screen.
///
/// Colour codes and other control characters go, since the panel would show
/// them as junk. So does anything shaped like a secret: an Anthropic key or
/// token by its prefix, and any long unbroken run of token characters, which
/// is what is left of one when the tail of the file began in the middle of
/// it. The CLI redacts its own logs; this is for the day an error line of its
/// does not. A path survives: its slashes and dots break the run.
fn sayable(text: &str) -> Option<String> {
    static UNSAYABLE: OnceLock<Option<(regex::Regex, regex::Regex)>> = OnceLock::new();
    let patterns = UNSAYABLE.get_or_init(|| {
        let escapes = regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").ok()?;
        let secrets = regex::Regex::new(r"sk-ant-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{40,}").ok()?;
        Some((escapes, secrets))
    });
    // Without the patterns there is no telling what the line holds.
    let (escapes, secrets) = patterns.as_ref()?;
    let plain: String = escapes
        .replace_all(text, "")
        .chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .collect();
    let line = plain.lines().rev().map(str::trim).find(|l| !l.is_empty())?;
    let clean = secrets.replace_all(line, "[redacted]");
    Some(clean.chars().take(SAID_MAX).collect())
}

/// What `helper_output` in `chats` calls a child that outstayed its budget;
/// the same words here, since the panel shows either.
const TIMED_OUT: &str = crate::chats::HELPER_TIMED_OUT;

/// Wait for the renewal to leave by itself, and ask it to if it does not.
/// `child` leads its own process group, as `command` starts it.
fn finish(mut child: Child, timeout: Duration, grace: Duration) -> Result<(), String> {
    match wait_until(&mut child, Instant::now() + timeout) {
        Ok(Some(status)) if status.success() => Ok(()),
        Ok(Some(_)) => Err("claude exited with an error".into()),
        Ok(None) => {
            stop(&mut child, grace);
            Err(TIMED_OUT.into())
        }
        // The wait itself failed, so there is no saying the child is still
        // there to signal. `Child` knows whether it reaped it, and its own
        // kill and wait are safe either way.
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(e.to_string())
        }
    }
}

/// Poll for the child's exit until `deadline`. `None` is still running.
fn wait_until(child: &mut Child, deadline: Instant) -> std::io::Result<Option<ExitStatus>> {
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// End a renewal that is still running: asked first, killed only if it does
/// not listen, and reaped either way.
///
/// Asked, because of what it may be in the middle of. See `RENEW_TIMEOUT`.
/// Only for a child `try_wait` has just reported running.
fn stop(child: &mut Child, grace: Duration) {
    signal_group(child, libc::SIGTERM);
    if !matches!(wait_until(child, Instant::now() + grace), Ok(Some(_))) {
        signal_group(child, libc::SIGKILL);
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Signal the renewal and whatever it started: the group it leads.
fn signal_group(child: &Child, signal: libc::c_int) {
    // SAFETY: `kill` only sends a signal. The target is the process group led
    // by this process's own child, which `stop` reaches only while that child
    // is unreaped: its pid, and so the group's id, cannot have passed to
    // anything else.
    unsafe { libc::kill(-(child.id() as libc::pid_t), signal) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::ffi::OsStr;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

    fn slot() -> Mutex<Slot> {
        Mutex::new(Slot::default())
    }

    #[test]
    fn a_lapsed_sign_in_is_renewed_once() {
        let slot = slot();
        let (ran, lapsed) = (Cell::new(0), Cell::new(true));
        let outcome = renew_in(
            &slot,
            || lapsed.get(),
            Instant::now,
            || {
                ran.set(ran.get() + 1);
                lapsed.set(false);
                Ok(())
            },
        );
        assert_eq!(outcome, Ok(()));
        assert_eq!(ran.get(), 1);
    }

    /// Every window asks at once after a switch. The ones that waited on the
    /// lock find the token already renewed and must not start the CLI again.
    #[test]
    fn nothing_runs_when_another_caller_already_renewed() {
        let slot = slot();
        let ran = Cell::new(0);
        let outcome = renew_in(
            &slot,
            || false,
            Instant::now,
            || {
                ran.set(ran.get() + 1);
                Ok(())
            },
        );
        assert_eq!(outcome, Ok(()));
        assert_eq!(ran.get(), 0);
    }

    /// The same, with the waiting done for real: two threads, one account.
    #[test]
    fn two_callers_at_once_share_one_run() {
        let slot = Arc::new(slot());
        let lapsed = Arc::new(AtomicBool::new(true));
        let ran = Arc::new(AtomicU32::new(0));
        let callers: Vec<_> = (0..2)
            .map(|_| {
                let (slot, lapsed, ran) = (slot.clone(), lapsed.clone(), ran.clone());
                std::thread::spawn(move || {
                    renew_in(
                        &slot,
                        || lapsed.load(Ordering::SeqCst),
                        Instant::now,
                        || {
                            ran.fetch_add(1, Ordering::SeqCst);
                            // Long enough for the other caller to be waiting.
                            std::thread::sleep(Duration::from_millis(50));
                            lapsed.store(false, Ordering::SeqCst);
                            Ok(())
                        },
                    )
                })
            })
            .collect();
        for caller in callers {
            assert_eq!(caller.join().unwrap(), Ok(()));
        }
        assert_eq!(ran.load(Ordering::SeqCst), 1);
    }

    /// A machine with no network yet: the windows asking together share the
    /// one run and its reason, and the next ask after that tries again.
    #[test]
    fn a_run_that_changed_nothing_is_shared_briefly_then_retried() {
        let slot = slot();
        let ran = Cell::new(0);
        let start = Instant::now();
        let futile = || {
            ran.set(ran.get() + 1);
            Err("timed out".to_string())
        };
        let first = renew_in(&slot, || true, || start, futile);
        let soon = start + FUTILE_FOR / 2;
        let second = renew_in(&slot, || true, || soon, futile);
        assert_eq!(ran.get(), 1);
        assert_eq!(first, Err("timed out".to_string()));
        assert_eq!(second, first);

        let later = start + FUTILE_FOR + Duration::from_secs(1);
        renew_in(&slot, || true, || later, futile).unwrap_err();
        assert_eq!(ran.get(), 2);
    }

    /// A run that renewed leaves nothing behind: the next lapse, eight hours
    /// on, is an ordinary one.
    #[test]
    fn a_run_that_renewed_is_not_remembered() {
        let slot = slot();
        let (ran, lapsed) = (Cell::new(0), Cell::new(true));
        let start = Instant::now();
        let renewing = || {
            ran.set(ran.get() + 1);
            lapsed.set(false);
            Ok(())
        };
        renew_in(&slot, || lapsed.get(), || start, renewing).unwrap();
        lapsed.set(true);
        renew_in(&slot, || lapsed.get(), || start, renewing).unwrap();
        assert_eq!(ran.get(), 2);
    }

    /// One account on a slow network must not hold up another's renewal, nor
    /// its futile run stand in for the other's.
    #[test]
    fn each_account_has_its_own_slot() {
        let slots: Slots = Mutex::new(HashMap::new());
        let work = slot_of(&slots, "work");
        assert!(Arc::ptr_eq(&work, &slot_of(&slots, "work")));
        let main = slot_of(&slots, "main");
        assert!(!Arc::ptr_eq(&work, &main));

        let held = work.lock();
        assert!(main.try_lock().is_some());
        drop(held);
    }

    fn built() -> Command {
        command(
            "/bin/claude",
            "work",
            Path::new("/tmp/renew"),
            Stdio::null(),
        )
    }

    /// The flags are what make the start silent and free. Losing any of them
    /// turns a renewal into a session: hooks firing, MCP servers starting, a
    /// transcript on the rail, or a refusal to start with no prompt.
    #[test]
    fn the_renewal_start_takes_no_prompt_and_leaves_nothing_behind() {
        let command = built();
        let args: Vec<_> = command.get_args().filter_map(OsStr::to_str).collect();
        let after = |flag: &str| {
            args.iter()
                .position(|arg| *arg == flag)
                .and_then(|at| args.get(at + 1))
                .copied()
        };
        assert!(args.contains(&"--print"));
        assert!(args.contains(&"--verbose"));
        assert!(args.contains(&"--safe-mode"));
        assert!(args.contains(&"--no-session-persistence"));
        assert_eq!(after("--input-format"), Some("stream-json"));
        assert_eq!(after("--output-format"), Some("stream-json"));
        assert_eq!(command.get_current_dir(), Some(Path::new("/tmp/renew")));
    }

    /// A key or a long-lived token exported in the shell that launched the app
    /// would be what the CLI signs in with, and the stored login would never
    /// be touched.
    #[test]
    fn the_renewal_runs_on_the_stored_login_and_nothing_else() {
        let command = built();
        let env: HashMap<_, _> = command.get_envs().collect();
        for variable in AUTH_OVERRIDES {
            assert_eq!(
                env.get(OsStr::new(variable)),
                Some(&None),
                "{variable} is passed on"
            );
        }
        assert_eq!(
            env.get(OsStr::new("CLAUDE_CODE_ENTRYPOINT")),
            Some(&Some(OsStr::new(ENTRYPOINT_RENEW)))
        );
        // Another account's directory, by the one rule every child follows.
        let config = env.get(OsStr::new(crate::account::CONFIG_DIR_VAR));
        assert!(matches!(config, Some(Some(dir)) if Path::new(dir).ends_with("work")));
    }

    #[test]
    fn main_renews_with_no_config_dir_at_all() {
        let command = command("/bin/claude", "main", Path::new("/tmp"), Stdio::null());
        let env: HashMap<_, _> = command.get_envs().collect();
        assert_eq!(
            env.get(OsStr::new(crate::account::CONFIG_DIR_VAR)),
            Some(&None)
        );
    }

    #[test]
    fn the_last_thing_said_is_the_last_non_empty_line() {
        assert_eq!(
            sayable("warming up\nerror: unknown option '--safe-mode'\n\n").as_deref(),
            Some("error: unknown option '--safe-mode'")
        );
        assert_eq!(sayable(""), None);
        assert_eq!(sayable("\n  \n"), None);
    }

    #[test]
    fn a_token_in_what_was_said_is_struck_out_and_a_long_line_cut() {
        assert_eq!(
            sayable("refused sk-ant-oat01-AbC_d-9 for work").as_deref(),
            Some("refused [redacted] for work")
        );
        let long = "x ".repeat(SAID_MAX * 2);
        assert_eq!(sayable(&long).map(|s| s.chars().count()), Some(SAID_MAX));
    }

    /// The tail of the file can begin in the middle of a token, which leaves
    /// it without the prefix it is known by.
    #[test]
    fn a_long_run_of_token_characters_is_struck_out_whatever_it_starts_with() {
        let headless = format!("d-9{} was refused", "aB3_".repeat(12));
        assert_eq!(
            sayable(&headless).as_deref(),
            Some("[redacted] was refused")
        );
        // A path is not one run: its slashes and dots break it.
        let path = "cannot read /home/someone/.local/share/claude/versions/2.1.322/settings.json";
        assert_eq!(sayable(path).as_deref(), Some(path));
    }

    #[test]
    fn colour_codes_and_control_characters_do_not_reach_the_panel() {
        assert_eq!(
            sayable("\u{1b}[31merror:\u{1b}[0m unknown option\u{7} '--safe-mode'\r\n").as_deref(),
            Some("error: unknown option '--safe-mode'")
        );
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mangouste-renew-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn what_was_said_is_kept_in_a_file_only_this_user_can_read() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("said");
        let path = dir.join("renew.err");
        let mut said = private_file(&path).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        writeln!(said, "first\nerror: unknown option '--safe-mode'").unwrap();
        assert_eq!(
            last_line(said).as_deref(),
            Some("error: unknown option '--safe-mode'")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The name is one anyone could guess. A link left under it, pointing at
    /// a file of this user's, must not be written through.
    #[test]
    fn a_link_at_the_files_path_is_taken_away_not_followed() {
        let dir = scratch("link");
        let target = dir.join("precious");
        std::fs::write(&target, "keep me").unwrap();
        let path = dir.join("renew.err");
        std::os::unix::fs::symlink(&target, &path).unwrap();

        let said = private_file(&path);

        assert!(said.is_some());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep me");
        assert!(!std::fs::symlink_metadata(&path).unwrap().is_symlink());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A child in a group of its own, as `command` starts the real one.
    fn grouped(program: &str, args: &[&str]) -> Child {
        Command::new(program)
            .args(args)
            .process_group(0)
            .spawn()
            .unwrap()
    }

    /// Whether `pid` still names a process, running or not yet reaped.
    fn exists(pid: u32) -> bool {
        // SAFETY: signal 0 sends nothing; it only asks whether the pid exists.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    #[test]
    fn a_renewal_that_exits_by_itself_is_reaped_with_its_outcome() {
        let ok = grouped("true", &[]);
        assert_eq!(
            finish(ok, Duration::from_secs(5), Duration::from_secs(1)),
            Ok(())
        );
        let failed = grouped("false", &[]);
        assert_eq!(
            finish(failed, Duration::from_secs(5), Duration::from_secs(1)),
            Err("claude exited with an error".to_string())
        );
    }

    /// Past its budget the child is asked to leave, which `sleep` does at
    /// once: well inside the grace, so it was the signal and not the kill.
    #[test]
    fn a_renewal_past_its_budget_is_asked_to_stop_and_reaped() {
        let child = grouped("sleep", &["30"]);
        let pid = child.id();
        let started = Instant::now();
        let outcome = finish(child, Duration::from_millis(100), Duration::from_secs(10));
        assert_eq!(outcome, Err(TIMED_OUT.to_string()));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!exists(pid));
    }

    /// A child that ignores the request is killed once the grace runs out,
    /// and not before: the grace is what a refresh in flight finishes in.
    /// What it started goes with it, being in its group.
    #[test]
    fn a_renewal_that_will_not_stop_is_killed_after_the_grace() {
        let child = grouped("sh", &["-c", "trap '' TERM; sleep 30"]);
        let pid = child.id();
        let (timeout, grace) = (Duration::from_millis(100), Duration::from_millis(400));
        let started = Instant::now();
        let outcome = finish(child, timeout, grace);
        assert_eq!(outcome, Err(TIMED_OUT.to_string()));
        assert!(started.elapsed() >= timeout + grace);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!exists(pid));
    }

    /// Starts the real CLI under the account in effect, so it needs the
    /// binary and a network. Spends no tokens and writes no transcript.
    /// `cargo test starts_and_leaves_with_nothing_said -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn starts_and_leaves_with_nothing_said() {
        let name = crate::account::current_name();
        let started = Instant::now();
        let outcome = run(&name);
        eprintln!(
            "renewal start on {name}: {outcome:?} in {:?}",
            started.elapsed()
        );
        assert_eq!(outcome, Ok(()));
    }
}
