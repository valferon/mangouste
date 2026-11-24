//! Which Claude Code account this process reads and spawns under.
//!
//! The CLI keeps everything about an account — credentials, `.claude.json`,
//! sessions, history, and by default the transcripts too — in one config
//! directory: `~/.claude`, or wherever `CLAUDE_CONFIG_DIR` points. Running two
//! accounts side by side is therefore two directories and an environment
//! variable, and the convention this app follows is the one `claude-acct` style
//! wrappers use: `main` is `~/.claude`, and every other account is a directory
//! under `~/.claude-accounts/<name>`.
//!
//! Three things depend on the choice, and all three come through here so they
//! cannot disagree: the transcripts the rail scans (`projects_root`), the state
//! and credentials the usage and dashboard panes read (`state_file`,
//! `credentials_file_of`), and the environment every `claude` child gets
//! (`apply`, `apply_pty`). A child spawned before a switch keeps the account it
//! started with; the environment is read once, at spawn.
//!
//! The choice is the app's, not the window's, so it lives in a file next to
//! `hooks.json` rather than in a webview's storage: the session watcher and
//! the first rail scan run before any frontend is up to say otherwise. With no
//! file, the account the process was launched under wins — a
//! `CLAUDE_CONFIG_DIR=… mangouste` keeps working — and failing that, `main`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// The CLI's own name for the override; set on children, read at launch.
pub const CONFIG_DIR_VAR: &str = "CLAUDE_CONFIG_DIR";

/// The account the CLI uses with no override: `~/.claude`.
pub const MAIN: &str = "main";

/// Where the extra accounts live, by name, under the home directory.
const ACCOUNTS_DIR: &str = ".claude-accounts";

/// Emitted to every window when the account changes, so panes that read the
/// account's state — the usage window, the dashboard — refetch.
pub const EVENT_CHANGED: &str = "account://changed";

/// Emitted when an account is called something else. Its own event, because
/// nothing about any account's state has moved: only the lists that show the
/// names reload, and the usage window and the dashboard stay as they are.
pub const EVENT_LABELS: &str = "account://labels";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// `main`, or the directory name under `~/.claude-accounts`.
    pub name: String,
    /// The config directory the CLI would be pointed at.
    pub dir: String,
    /// The signed-in address from the account's `.claude.json`, when there is one.
    pub email: Option<String>,
    /// What the person calls it, when they have said. `name` is a directory
    /// and stays one; this is what the switcher shows in its place.
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Accounts {
    pub accounts: Vec<Account>,
    /// The name of the account in effect; always one of `accounts`.
    pub current: String,
}

/// The paths an account resolution needs, separated from where they come from
/// so the rules can be tested without a home directory.
#[derive(Debug, Clone)]
struct Layout {
    home: PathBuf,
}

impl Layout {
    fn real() -> Option<Self> {
        dirs::home_dir().map(|home| Layout { home })
    }

    fn main_dir(&self) -> PathBuf {
        self.home.join(".claude")
    }

    fn accounts_dir(&self) -> PathBuf {
        self.home.join(ACCOUNTS_DIR)
    }

    /// The config directory for `name`, whether or not it exists.
    fn dir_of(&self, name: &str) -> PathBuf {
        if name == MAIN {
            self.main_dir()
        } else {
            self.accounts_dir().join(name)
        }
    }

    /// Every account on disk: `main` first, the rest by name.
    fn names(&self) -> Vec<String> {
        let mut names = vec![MAIN.to_string()];
        if let Ok(entries) = std::fs::read_dir(self.accounts_dir()) {
            let mut extra: Vec<String> = entries
                .flatten()
                .filter(|entry| entry.path().is_dir())
                .filter_map(|entry| entry.file_name().into_string().ok())
                // `main` is `~/.claude` alone: a directory of that name here
                // would list it twice, both rows resolving to the same place.
                .filter(|name| name != MAIN && valid_name(name))
                .collect();
            extra.sort();
            names.extend(extra);
        }
        names
    }

    /// The name of the account `dir` is, if it is one of ours.
    fn name_of(&self, dir: &Path) -> Option<String> {
        if same_dir(dir, &self.main_dir()) {
            return Some(MAIN.to_string());
        }
        self.names()
            .into_iter()
            .find(|name| same_dir(dir, &self.dir_of(name)))
    }
}

/// Two paths naming one directory, through symlinks when both resolve.
fn same_dir(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// A name is a directory name under `~/.claude-accounts`, and only that: no
/// separators, no dot-prefixed entries, nothing a path could be smuggled in.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Where the choice is kept: one line, the account name.
fn choice_file() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("mangouste").join("account"))
}

fn read_choice(path: Option<&Path>) -> Option<String> {
    let text = std::fs::read_to_string(path?).ok()?;
    let name = text.trim().to_string();
    valid_name(&name).then_some(name)
}

fn write_choice(path: &Path, name: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Written beside and renamed over: a crash mid-write must not leave an
    // empty file that reads as "no choice" and silently falls back to main.
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, format!("{name}\n")).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// The account in effect, by the rules in the module doc.
///
/// `stored` is the saved choice, `launch` the directory the process was given
/// in its environment. A stored name whose directory is gone is ignored rather
/// than honoured: pointing the CLI at a missing config dir makes it create a
/// fresh, signed-out one there, which is never what a stale choice meant.
fn resolve(layout: &Layout, stored: Option<&str>, launch: Option<&Path>) -> String {
    if let Some(name) = stored {
        if layout.dir_of(name).is_dir() {
            return name.to_string();
        }
    }
    if let Some(name) = launch.and_then(|dir| layout.name_of(dir)) {
        return name;
    }
    MAIN.to_string()
}

/// The directory the process was launched under, if any.
fn launch_dir() -> Option<PathBuf> {
    std::env::var_os(CONFIG_DIR_VAR)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// The name of the account in effect.
pub fn current_name() -> String {
    let Some(layout) = Layout::real() else {
        return MAIN.to_string();
    };
    let stored = read_choice(choice_file().as_deref());
    resolve(&layout, stored.as_deref(), launch_dir().as_deref())
}

/// The config directory of the account in effect.
///
/// `None` only without a home directory, which is the same condition every
/// `~/.claude` reader already fails on.
pub fn config_dir() -> Option<PathBuf> {
    Layout::real().map(|layout| layout.dir_of(&current_name()))
}

/// The transcripts the rail scans: `<config dir>/projects`.
pub fn projects_root() -> Option<PathBuf> {
    config_dir().map(|dir| dir.join("projects"))
}

/// The CLI's state file: `~/.claude.json` for `main`, `<dir>/.claude.json`
/// for any other account — the CLI moves it inside the config dir when
/// `CLAUDE_CONFIG_DIR` is set.
pub fn state_file() -> Option<PathBuf> {
    let layout = Layout::real()?;
    Some(state_file_in(&layout, &current_name()))
}

fn state_file_in(layout: &Layout, name: &str) -> PathBuf {
    if name == MAIN {
        layout.home.join(".claude.json")
    } else {
        layout.dir_of(name).join(".claude.json")
    }
}

/// The credentials file of `name`: `<config dir>/.credentials.json` on every
/// account. By name rather than for the account in effect, so a caller that
/// reads, renews and reads again stays on one account through a switch.
pub fn credentials_file_of(name: &str) -> Option<PathBuf> {
    Layout::real().map(|layout| layout.dir_of(name).join(".credentials.json"))
}

/// The `CLAUDE_CONFIG_DIR` a child on `name` gets: `None` means unset.
///
/// `main` removes the variable rather than setting it to `~/.claude`: an
/// explicit path and an absent one are the same account to the CLI, but a set
/// variable is what tells a `claude-acct`-style wrapper in a terminal that a
/// non-default account is in force, and `main` is not one.
///
/// Set or unset is also what the CLI names its macOS keychain item by, so the
/// usage reader asks this to find the item a child on `name` wrote.
pub(crate) fn env_for(name: &str) -> Option<PathBuf> {
    if name == MAIN {
        return None;
    }
    Layout::real().map(|layout| layout.dir_of(name))
}

/// Point a child at the account in effect.
pub fn apply(command: &mut Command) -> &mut Command {
    apply_as(command, &current_name())
}

/// Point a child at `name`, for a caller that has to record which account it
/// spawned under and so cannot read the choice a second time.
pub fn apply_as<'a>(command: &'a mut Command, name: &str) -> &'a mut Command {
    match env_for(name) {
        Some(dir) => command.env(CONFIG_DIR_VAR, dir),
        None => command.env_remove(CONFIG_DIR_VAR),
    }
}

/// `apply`, for the terminal's command builder.
pub fn apply_pty(command: &mut portable_pty::CommandBuilder) {
    match env_for(&current_name()) {
        Some(dir) => command.env(CONFIG_DIR_VAR, dir),
        None => command.env_remove(CONFIG_DIR_VAR),
    }
}

/// Make `session_id` resumable on account `name`.
///
/// The CLI only resumes a transcript it finds under its own `projects`, so a
/// session written on one account and continued on another needs a copy there
/// first. With `projects` shared between accounts (the `claude-acct` layout)
/// it is already in place and nothing is copied. Otherwise the transcript and
/// its sidecar directory (subagent logs, saved tool output) are copied once,
/// into the same project directory name; the original is left alone, so the
/// first account's history stays as it was.
///
/// Best effort: a failed copy leaves the resume to start fresh under the same
/// id, which is what it did before this existed.
pub fn carry_transcript(session_id: &str, name: &str) -> Option<PathBuf> {
    let layout = Layout::real()?;
    carry_in(&layout, name, session_id)
}

fn carry_in(layout: &Layout, name: &str, session_id: &str) -> Option<PathBuf> {
    // A session id becomes a file name below; nothing else may pass.
    if !valid_name(session_id) {
        return None;
    }
    let file = format!("{session_id}.jsonl");
    let target_root = layout.dir_of(name).join("projects");
    if let Some((found, _)) = find_transcript(&target_root, &file) {
        return Some(found);
    }
    for other in layout.names() {
        let root = layout.dir_of(&other).join("projects");
        if other == name || same_dir(&root, &target_root) {
            continue;
        }
        let Some((source, project)) = find_transcript(&root, &file) else {
            continue;
        };
        let dest_dir = target_root.join(project);
        std::fs::create_dir_all(&dest_dir).ok()?;
        let dest = dest_dir.join(&file);
        // Copied beside and renamed over. A copy cut short (a full disk, the
        // app killed) must not leave half a transcript under the real name:
        // the next carry would find it there and call the session carried.
        let partial = dest_dir.join(format!("{file}.tmp"));
        if std::fs::copy(&source, &partial).is_err() || std::fs::rename(&partial, &dest).is_err() {
            let _ = std::fs::remove_file(&partial);
            return None;
        }
        let sidecar = source.with_extension("");
        if sidecar.is_dir() {
            let _ = copy_tree(&sidecar, &dest_dir.join(session_id));
        }
        return Some(dest);
    }
    None
}

/// `<root>/<project>/<file>`, and the project directory's name.
fn find_transcript(root: &Path, file: &str) -> Option<(PathBuf, std::ffi::OsString)> {
    std::fs::read_dir(root).ok()?.flatten().find_map(|entry| {
        let candidate = entry.path().join(file);
        candidate.is_file().then(|| (candidate, entry.file_name()))
    })
}

/// A plain recursive copy that skips symlinks rather than following them.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)?.flatten() {
        let kind = entry.file_type()?;
        let dest = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &dest)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

/// The signed-in address in a state file, when it has one.
fn email_in(state_file: &Path) -> Option<String> {
    let text = std::fs::read_to_string(state_file).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get("oauthAccount")?
        .get("emailAddress")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn list(layout: &Layout, current: &str, labels: &crate::labels::Labels) -> Accounts {
    let accounts = layout
        .names()
        .into_iter()
        .map(|name| Account {
            dir: layout.dir_of(&name).to_string_lossy().into_owned(),
            email: email_in(&state_file_in(layout, &name)),
            label: labels.get(&name).cloned(),
            name,
        })
        .collect();
    Accounts {
        accounts,
        current: current.to_string(),
    }
}

/// `list`, with the labels on disk.
fn listed(layout: &Layout, current: &str) -> Accounts {
    list(layout, current, &crate::labels::read())
}

/// What `name` is called on screen: its label, else the address it is signed
/// in as, else the name. For the messages the backend writes about an
/// account, so they name it the way the switcher does.
pub fn title(name: &str) -> String {
    let label = crate::labels::read().remove(name);
    let email = Layout::real().and_then(|layout| email_in(&state_file_in(&layout, name)));
    crate::labels::title(label.as_deref(), email.as_deref(), name)
}

/// Every account on disk, and which one is in effect.
#[tauri::command(async)]
pub fn account_list() -> Result<Accounts, String> {
    let layout = Layout::real().ok_or("no home directory")?;
    Ok(listed(&layout, &current_name()))
}

/// Every account but `name`, with what each shows as: what a label for
/// `name` must not be mistaken for.
fn others(layout: &Layout, name: &str) -> Vec<crate::labels::Other> {
    layout
        .names()
        .into_iter()
        .filter(|other| other != name)
        .map(|other| crate::labels::Other {
            email: email_in(&state_file_in(layout, &other)),
            name: other,
        })
        .collect()
}

/// Call account `name` what was typed, or take its label off when that is
/// blank. The directory keeps its name: see `labels`.
#[tauri::command(async)]
pub fn account_rename(app: AppHandle, name: String, label: String) -> Result<Accounts, String> {
    let layout = Layout::real().ok_or("no home directory")?;
    if !layout.names().contains(&name) {
        return Err(format!("no account {name}"));
    }
    crate::labels::set(&name, &label, &others(&layout, &name))?;
    let current = current_name();
    let _ = app.emit(EVENT_LABELS, &name);
    Ok(listed(&layout, &current))
}

/// Make `name` the account in effect, for new children and every reader.
///
/// Tells the rail to rescan, since its root may have moved, and starts a
/// watcher on the new root if none is on it yet.
#[tauri::command(async)]
pub fn account_set(app: AppHandle, name: String) -> Result<Accounts, String> {
    if !valid_name(&name) {
        return Err(format!("not an account name: {name}"));
    }
    let layout = Layout::real().ok_or("no home directory")?;
    if !layout.dir_of(&name).is_dir() {
        return Err(format!(
            "no account {name}: {}",
            layout.dir_of(&name).display()
        ));
    }
    let path = choice_file().ok_or("no config directory to keep the choice in")?;
    write_choice(&path, &name)?;

    if let Some(root) = projects_root() {
        crate::watch_projects_root(app.clone(), root);
    }
    let _ = app.emit(crate::EVENT_SESSIONS_CHANGED, ());
    let _ = app.emit(EVENT_CHANGED, &name);
    Ok(listed(&layout, &name))
}

/// What a new account shares with `main` by symlink, as `claude-acct` does:
/// instructions, settings, extensions and the transcripts. Everything that is
/// about who is signed in (credentials, `.claude.json`, sessions, history,
/// policy) stays per account.
const SHARED: &[&str] = &[
    "CLAUDE.md",
    "settings.json",
    "settings.local.json",
    "keybindings.json",
    "rules",
    "agents",
    "commands",
    "skills",
    "hooks",
    "plugins",
    "scripts",
    "projects",
];

/// Create account `name`: its directory, the shared links, and a seed state.
///
/// The seed carries the user-scope MCP servers and skips the CLI's first-run
/// onboarding; no login or org data, so the account starts signed out.
fn add_in(layout: &Layout, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err(format!("not an account name: {name}"));
    }
    if name == MAIN {
        return Err("main already exists (~/.claude)".into());
    }
    let dir = layout.dir_of(name);
    if dir.symlink_metadata().is_ok() {
        return Err(format!("{} already exists", dir.display()));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    set_mode(&dir, 0o700);
    let main = layout.main_dir();
    for item in SHARED {
        let source = main.join(item);
        if source.exists() {
            std::os::unix::fs::symlink(&source, dir.join(item)).map_err(|e| e.to_string())?;
        }
    }
    let seed = seed_state(&state_file_in(layout, MAIN));
    let state = dir.join(".claude.json");
    std::fs::write(&state, seed).map_err(|e| e.to_string())?;
    set_mode(&state, 0o600);
    Ok(dir)
}

fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

/// `{mcpServers, theme, hasCompletedOnboarding: true}` out of main's state.
fn seed_state(main_state: &Path) -> String {
    let main: serde_json::Value = std::fs::read_to_string(main_state)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    let mut seed = serde_json::Map::new();
    seed.insert(
        "mcpServers".into(),
        main.get("mcpServers")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
    );
    if let Some(theme) = main.get("theme").filter(|v| !v.is_null()) {
        seed.insert("theme".into(), theme.clone());
    }
    seed.insert("hasCompletedOnboarding".into(), true.into());
    serde_json::Value::Object(seed).to_string()
}

/// Delete account `name`. Never `main`, never the one in effect.
///
/// The shared entries are symlinks and are unlinked, not followed, so what
/// they point at in `~/.claude` is untouched. An account whose `projects` is
/// its own directory loses those transcripts with it.
fn remove_in(layout: &Layout, name: &str, current: &str) -> Result<(), String> {
    if !valid_name(name) {
        return Err(format!("not an account name: {name}"));
    }
    if name == MAIN {
        return Err("main cannot be removed".into());
    }
    if name == current {
        return Err(format!("{name} is the account in use; switch first"));
    }
    let dir = layout.dir_of(name);
    let meta = dir
        .symlink_metadata()
        .map_err(|_| format!("no account {name}"))?;
    if !meta.is_dir() {
        return Err(format!("{} is not a directory", dir.display()));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

/// Create an account. It starts signed out; `account_login` signs it in.
///
/// `label` is what the person called it, when that is not the directory's
/// name. It is checked before the directory is made, so a name another
/// account answers to is refused with nothing created rather than leaving an
/// account behind under a name nobody chose.
#[tauri::command(async)]
pub fn account_add(
    app: AppHandle,
    name: String,
    label: Option<String>,
) -> Result<Accounts, String> {
    let layout = Layout::real().ok_or("no home directory")?;
    let label = label
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty() && *label != name);
    let rest = others(&layout, &name);
    if let Some(label) = label {
        crate::labels::check(&name, label, &rest)?;
    }
    add_in(&layout, &name)?;
    let named = label.map_or(Ok(()), |label| crate::labels::set(&name, label, &rest));
    let _ = app.emit(EVENT_CHANGED, current_name());
    named.map_err(|e| format!("made {name}, but could not name it: {e}"))?;
    Ok(listed(&layout, &current_name()))
}

/// Delete an account's directory.
#[tauri::command(async)]
pub fn account_remove(app: AppHandle, name: String) -> Result<Accounts, String> {
    let layout = Layout::real().ok_or("no home directory")?;
    let current = current_name();
    remove_in(&layout, &name, &current)?;
    crate::labels::forget(&name);
    let _ = app.emit(EVENT_CHANGED, &current);
    Ok(listed(&layout, &current))
}

/// Emitted with each line `claude auth login` prints, and once when it ends.
pub const EVENT_LOGIN: &str = "account://login";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginEvent {
    name: String,
    line: Option<String>,
    /// Set on the last event: whether the login exited cleanly.
    done: Option<bool>,
}

/// The logins in progress, by account, so one can be cancelled and a second
/// click does not start a second browser flow for the same account.
fn logins() -> &'static Mutex<std::collections::HashMap<String, u32>> {
    static LOGINS: OnceLock<Mutex<std::collections::HashMap<String, u32>>> = OnceLock::new();
    LOGINS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Sign `name` in with `claude auth login`, run under that account's dir.
///
/// The CLI opens the browser and waits for the callback; its output (the URL,
/// should the browser not open) streams back as `account://login` events. No
/// stdin: a flow that wants a pasted code ends instead of hanging, and the
/// hint in Settings says to use a terminal for that one.
#[tauri::command(async)]
pub fn account_login(app: AppHandle, name: String) -> Result<(), String> {
    use std::io::BufRead;
    use std::process::Stdio;

    let layout = Layout::real().ok_or("no home directory")?;
    if !valid_name(&name) || !layout.dir_of(&name).is_dir() {
        return Err(format!("no account {name}"));
    }
    let mut logins_guard = logins().lock().unwrap();
    if logins_guard.contains_key(&name) {
        return Err(format!("{name} is already signing in"));
    }
    let mut command = Command::new(crate::chats::claude_binary());
    crate::env::with_child_path(&mut command);
    apply_as(&mut command, &name);
    let mut child = command
        .args(["auth", "login"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run claude auth login: {e}"))?;
    logins_guard.insert(name.clone(), child.id());
    drop(logins_guard);

    let pipe = |reader: Box<dyn std::io::Read + Send>, app: AppHandle, name: String| {
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(reader)
                .lines()
                .map_while(Result::ok)
            {
                let _ = app.emit(
                    EVENT_LOGIN,
                    LoginEvent {
                        name: name.clone(),
                        line: Some(line),
                        done: None,
                    },
                );
            }
        })
    };
    let out = child
        .stdout
        .take()
        .map(|s| pipe(Box::new(s), app.clone(), name.clone()));
    let err = child
        .stderr
        .take()
        .map(|s| pipe(Box::new(s), app.clone(), name.clone()));
    std::thread::spawn(move || {
        let ok = child.wait().map(|s| s.success()).unwrap_or(false);
        // Cleared the moment the child is reaped, before the readers are
        // joined. A browser launcher that inherited a pipe can hold them open
        // long after, and for all that time the listed pid would no longer be
        // ours to signal and the account would still read as signing in.
        logins().lock().unwrap().remove(&name);
        for reader in [out, err].into_iter().flatten() {
            let _ = reader.join();
        }
        let _ = app.emit(
            EVENT_LOGIN,
            LoginEvent {
                name,
                line: None,
                done: Some(ok),
            },
        );
        // The email in the list comes from the state file the login wrote.
        let _ = app.emit(EVENT_CHANGED, current_name());
    });
    Ok(())
}

/// Stop a sign-in that is waiting on a browser nobody is going to finish.
#[tauri::command(async)]
pub fn account_login_cancel(name: String) -> Result<(), String> {
    let pid = logins().lock().unwrap().get(&name).copied();
    if let Some(pid) = pid {
        // The waiter thread reaps it and clears the entry, so the pid is still
        // ours while it is listed.
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    }
    Ok(())
}

/// The project roots already under a watcher, so a switch back to an account
/// does not stack a second one on the same directory.
pub fn watched_roots() -> &'static Mutex<HashSet<PathBuf>> {
    static WATCHED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    WATCHED.get_or_init(|| Mutex::new(HashSet::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway home, removed on drop. The std temp dir plus a unique name,
    /// as the rest of the crate's tests do, rather than a crate for one call.
    struct TempHome(PathBuf);

    impl TempHome {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("mangouste-account-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TempHome(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn layout(name: &str) -> (TempHome, Layout) {
        let home = TempHome::new(name);
        std::fs::create_dir_all(home.path().join(".claude")).unwrap();
        let layout = Layout {
            home: home.path().to_path_buf(),
        };
        (home, layout)
    }

    fn add(layout: &Layout, name: &str) -> PathBuf {
        let dir = layout.dir_of(name);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn names_are_directory_names_only() {
        assert!(valid_name("work"));
        assert!(valid_name("client-2_b"));
        assert!(!valid_name(""));
        assert!(!valid_name(".hidden"));
        assert!(!valid_name("../escape"));
        assert!(!valid_name("a/b"));
        assert!(!valid_name("with space"));
    }

    #[test]
    fn main_is_first_and_the_rest_sort() {
        let (_home, layout) = layout("main_is_first_and_the_rest_sort");
        add(&layout, "work");
        add(&layout, "client");
        std::fs::write(layout.accounts_dir().join("stray-file"), "").unwrap();
        assert_eq!(layout.names(), ["main", "client", "work"]);
    }

    /// `main` is `~/.claude` and nothing else. A directory of that name under
    /// the accounts dir would otherwise be listed as a second `main`, both
    /// rows resolving to `~/.claude`.
    #[test]
    fn a_directory_named_main_is_not_a_second_main() {
        let (_home, layout) = layout("a_directory_named_main_is_not_a_second_main");
        add(&layout, "work");
        std::fs::create_dir_all(layout.accounts_dir().join("main")).unwrap();
        assert_eq!(layout.names(), ["main", "work"]);
    }

    #[test]
    fn main_is_the_only_account_without_an_accounts_dir() {
        let (_home, layout) = layout("main_is_the_only_account_without_an_accounts_dir");
        assert_eq!(layout.names(), ["main"]);
    }

    #[test]
    fn stored_choice_wins_when_its_directory_exists() {
        let (_home, layout) = layout("stored_choice_wins_when_its_directory_exists");
        let work = add(&layout, "work");
        add(&layout, "client");
        assert_eq!(resolve(&layout, Some("client"), Some(&work)), "client");
    }

    #[test]
    fn stale_choice_falls_through_to_launch_env() {
        let (_home, layout) = layout("stale_choice_falls_through_to_launch_env");
        let work = add(&layout, "work");
        assert_eq!(resolve(&layout, Some("gone"), Some(&work)), "work");
    }

    #[test]
    fn launch_env_naming_main_dir_is_main() {
        let (_home, layout) = layout("launch_env_naming_main_dir_is_main");
        let main = layout.main_dir();
        assert_eq!(resolve(&layout, None, Some(&main)), "main");
    }

    #[test]
    fn launch_env_outside_the_layout_is_ignored() {
        let (_home, layout) = layout("launch_env_outside_the_layout_is_ignored");
        let elsewhere = TempHome::new("elsewhere");
        assert_eq!(resolve(&layout, None, Some(elsewhere.path())), "main");
    }

    #[test]
    fn nothing_set_is_main() {
        let (_home, layout) = layout("nothing_set_is_main");
        assert_eq!(resolve(&layout, None, None), "main");
    }

    #[test]
    fn state_file_moves_inside_the_dir_for_extra_accounts() {
        let (_home, layout) = layout("state_file_moves_inside_the_dir_for_extra_accounts");
        assert_eq!(
            state_file_in(&layout, "main"),
            layout.home.join(".claude.json")
        );
        assert_eq!(
            state_file_in(&layout, "work"),
            layout.home.join(".claude-accounts/work/.claude.json")
        );
    }

    #[test]
    fn list_reads_each_accounts_email() {
        let (_home, layout) = layout("list_reads_each_accounts_email");
        let work = add(&layout, "work");
        std::fs::write(
            work.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"w@example.com"}}"#,
        )
        .unwrap();
        std::fs::write(layout.home.join(".claude.json"), r#"{"oauthAccount":{}}"#).unwrap();
        let listed = list(&layout, "work", &crate::labels::Labels::new());
        assert_eq!(listed.current, "work");
        let emails: Vec<_> = listed
            .accounts
            .iter()
            .map(|a| (a.name.as_str(), a.email.as_deref()))
            .collect();
        assert_eq!(emails, [("main", None), ("work", Some("w@example.com"))]);
    }

    /// A label rides on the account it was given to and nowhere else, and one
    /// left behind for an account that is gone names nothing.
    #[test]
    fn list_carries_each_accounts_label() {
        let (_home, layout) = layout("list_carries_each_accounts_label");
        add(&layout, "work");
        let labels: crate::labels::Labels = [("work", "Ops team"), ("gone", "Old")]
            .into_iter()
            .map(|(name, label)| (name.to_string(), label.to_string()))
            .collect();
        let listed = list(&layout, "main", &labels);
        let named: Vec<_> = listed
            .accounts
            .iter()
            .map(|a| (a.name.as_str(), a.label.as_deref()))
            .collect();
        assert_eq!(named, [("main", None), ("work", Some("Ops team"))]);
    }

    #[test]
    fn add_links_the_shared_parts_and_seeds_a_signed_out_state() {
        let (_home, layout) = layout("add_links_the_shared_parts");
        let main = layout.main_dir();
        std::fs::create_dir_all(main.join("projects")).unwrap();
        std::fs::write(main.join("settings.json"), "{}").unwrap();
        std::fs::write(
            layout.home.join(".claude.json"),
            r#"{"mcpServers":{"x":{}},"theme":"dark","oauthAccount":{"emailAddress":"m@example.com"}}"#,
        )
        .unwrap();
        let dir = add_in(&layout, "work").unwrap();
        assert!(dir
            .join("projects")
            .symlink_metadata()
            .unwrap()
            .is_symlink());
        assert!(dir
            .join("settings.json")
            .symlink_metadata()
            .unwrap()
            .is_symlink());
        assert!(dir.join("rules").symlink_metadata().is_err());
        let seed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude.json")).unwrap())
                .unwrap();
        assert_eq!(seed["theme"], "dark");
        assert_eq!(seed["hasCompletedOnboarding"], true);
        assert!(seed.get("oauthAccount").is_none());
        assert!(add_in(&layout, "work").is_err());
        assert!(add_in(&layout, "main").is_err());
        assert!(add_in(&layout, "../x").is_err());
    }

    #[test]
    fn remove_refuses_main_and_the_current_one_and_keeps_link_targets() {
        let (_home, layout) = layout("remove_refuses");
        std::fs::create_dir_all(layout.main_dir().join("projects")).unwrap();
        std::fs::write(layout.main_dir().join("projects").join("keep"), "").unwrap();
        add_in(&layout, "work").unwrap();
        assert!(remove_in(&layout, "main", "work").is_err());
        assert!(remove_in(&layout, "work", "work").is_err());
        remove_in(&layout, "work", "main").unwrap();
        assert!(!layout.dir_of("work").exists());
        assert!(layout.main_dir().join("projects").join("keep").is_file());
    }

    #[test]
    fn carry_copies_a_transcript_from_another_account_once() {
        let (_home, layout) = layout("carry_copies");
        let source = layout.main_dir().join("projects").join("-repo");
        std::fs::create_dir_all(source.join("s1").join("subagents")).unwrap();
        std::fs::write(source.join("s1.jsonl"), "{}\n").unwrap();
        std::fs::write(source.join("s1").join("subagents").join("a.jsonl"), "").unwrap();
        add(&layout, "work");
        let carried = carry_in(&layout, "work", "s1").unwrap();
        let expected = layout.dir_of("work").join("projects/-repo/s1.jsonl");
        assert_eq!(carried, expected);
        assert!(layout
            .dir_of("work")
            .join("projects/-repo/s1/subagents/a.jsonl")
            .is_file());
        // Already there: found, not copied again.
        std::fs::write(&expected, "{}\n{}\n").unwrap();
        carry_in(&layout, "work", "s1").unwrap();
        assert_eq!(std::fs::read_to_string(&expected).unwrap(), "{}\n{}\n");
        assert_eq!(carry_in(&layout, "work", "missing"), None);
        assert_eq!(carry_in(&layout, "work", "../s1"), None);
    }

    /// A copy killed midway leaves half a transcript. Under the real name the
    /// next carry would find it and call the session carried, so the copy goes
    /// to a temporary name first and that name is never the transcript.
    #[test]
    fn carry_lands_whole_and_replaces_what_a_cut_copy_left() {
        let (_home, layout) = layout("carry_lands_whole");
        let source = layout.main_dir().join("projects").join("-repo");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("s1.jsonl"), "{}\n{}\n").unwrap();
        add(&layout, "work");
        let dest_dir = layout.dir_of("work").join("projects/-repo");
        std::fs::create_dir_all(&dest_dir).unwrap();
        let partial = dest_dir.join("s1.jsonl.tmp");
        std::fs::write(&partial, "{").unwrap();

        let carried = carry_in(&layout, "work", "s1").unwrap();

        assert_eq!(carried, dest_dir.join("s1.jsonl"));
        assert_eq!(std::fs::read_to_string(&carried).unwrap(), "{}\n{}\n");
        assert!(!partial.exists());
    }

    #[test]
    fn carry_is_a_no_op_when_projects_is_shared() {
        let (_home, layout) = layout("carry_shared");
        let projects = layout.main_dir().join("projects");
        std::fs::create_dir_all(projects.join("-repo")).unwrap();
        std::fs::write(projects.join("-repo").join("s1.jsonl"), "").unwrap();
        let work = add(&layout, "work");
        std::os::unix::fs::symlink(&projects, work.join("projects")).unwrap();
        assert_eq!(
            carry_in(&layout, "work", "s1"),
            Some(work.join("projects/-repo/s1.jsonl"))
        );
    }

    #[test]
    fn choice_file_round_trips_and_rejects_junk() {
        let dir = TempHome::new("choice");
        let path = dir.path().join("nested").join("account");
        write_choice(&path, "work").unwrap();
        assert_eq!(read_choice(Some(&path)).as_deref(), Some("work"));
        std::fs::write(&path, "../nope\n").unwrap();
        assert_eq!(read_choice(Some(&path)), None);
        assert_eq!(read_choice(Some(&dir.path().join("missing"))), None);
    }
}
