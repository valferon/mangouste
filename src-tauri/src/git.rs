//! Git queries for the left sidebar's history/tree view.
//!
//! Everything shells out to `git` rather than linking libgit2: the porcelain
//! formats below are stable, and it keeps the build free of an OpenSSL dependency.

use std::io::Read;
use std::process::{Command, Stdio};

use serde::Serialize;

/// Field separator inside a `git log` record. `%x1f` is US, which cannot appear
/// in a commit subject, so splitting is unambiguous.
const FIELD_SEPARATOR: char = '\u{1f}';

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    pub author_email: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
    /// Ref decorations, e.g. `HEAD -> main`, `origin/main`, `tag: v1.2.0`.
    pub refs: Vec<String>,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    /// Two-character porcelain code, e.g. ` M`, `??`, `A `.
    pub code: String,
    pub path: String,
    /// Populated for renames and copies.
    pub original_path: Option<String>,
    pub staged: bool,
    pub unstaged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileStatus>,
}

/// git's own message, or a better one when the failure is not about the repo.
///
/// macOS ships `/usr/bin/git` as an Xcode shim, so `git` resolves and runs on a
/// machine that has no git at all — it just fails with `xcrun`'s wording, which
/// says nothing about what to install. Everything else is passed through
/// untouched: git's errors are good, and rewording them would only hide them.
fn explain(stderr: &str) -> String {
    let message = stderr.trim();
    if message.contains("invalid active developer path") || message.contains("xcrun: error") {
        return "git is not installed: the Xcode command line tools are missing. \
                Run `xcode-select --install`, or install git with Homebrew."
            .to_string();
    }
    message.to_string()
}

fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = crate::env::with_child_path(&mut Command::new("git"))
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !output.status.success() {
        return Err(explain(&String::from_utf8_lossy(&output.stderr)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Commit history, newest first. `--date-order` keeps parallel branches interleaved
/// by time, which is what a graph view wants.
///
/// Every command here is `async`: `Command::output` blocks until git finishes,
/// which on a cold cache or a big repo is long enough to freeze the UI.
#[tauri::command(async)]
pub fn git_log(
    cwd: String,
    limit: Option<usize>,
    skip: Option<usize>,
    all_branches: Option<bool>,
) -> Result<Vec<Commit>, String> {
    let limit = limit.unwrap_or(200).to_string();
    let skip = skip.unwrap_or(0).to_string();
    let format = format!(
        "--pretty=format:%H{sep}%h{sep}%an{sep}%ae{sep}%at{sep}%P{sep}%D{sep}%s",
        sep = FIELD_SEPARATOR
    );

    let mut args = vec!["log", "--date-order", "-n", &limit, "--skip", &skip, &format];
    if all_branches.unwrap_or(true) {
        args.push("--all");
    }

    let stdout = git(&cwd, &args)?;
    let commits = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(FIELD_SEPARATOR).collect();
            if fields.len() < 8 {
                return None;
            }
            Some(Commit {
                sha: fields[0].to_string(),
                short_sha: fields[1].to_string(),
                author: fields[2].to_string(),
                author_email: fields[3].to_string(),
                timestamp: fields[4].parse().unwrap_or(0),
                parents: fields[5].split_whitespace().map(str::to_string).collect(),
                refs: fields[6]
                    .split(',')
                    .map(str::trim)
                    .filter(|r| !r.is_empty())
                    .map(str::to_string)
                    .collect(),
                subject: fields[7].to_string(),
            })
        })
        .collect();
    Ok(commits)
}

/// Working tree status plus branch tracking info.
#[tauri::command(async)]
pub fn git_status(cwd: String) -> Result<RepoStatus, String> {
    let stdout = git(&cwd, &["status", "--porcelain=v1", "--branch", "-z"])?;

    let mut status = RepoStatus {
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
    };

    // `-z` uses NUL separators, so paths containing spaces or quotes stay intact.
    let mut records = stdout.split('\0').filter(|r| !r.is_empty()).peekable();

    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix("## ") {
            parse_branch_header(header, &mut status);
            continue;
        }
        if record.len() < 3 {
            continue;
        }
        let code = record[..2].to_string();
        let path = record[3..].to_string();
        // Rename and copy records are followed by the original path as its own
        // record. Either column can carry the R/C: ` R` is a worktree rename,
        // and missing it desyncs the whole -z record stream.
        let original_path = if code.contains('R') || code.contains('C') {
            records.next().map(str::to_string)
        } else {
            None
        };
        let index_char = code.chars().next().unwrap_or(' ');
        let worktree_char = code.chars().nth(1).unwrap_or(' ');
        status.files.push(FileStatus {
            staged: index_char != ' ' && index_char != '?',
            unstaged: worktree_char != ' ',
            code,
            path,
            original_path,
        });
    }

    Ok(status)
}

/// Parse the `## branch...upstream [ahead N, behind M]` header line.
fn parse_branch_header(header: &str, status: &mut RepoStatus) {
    let (refs_part, tracking_part) = match header.split_once(" [") {
        Some((refs, tracking)) => (refs, Some(tracking.trim_end_matches(']'))),
        None => (header, None),
    };

    match refs_part.split_once("...") {
        Some((branch, upstream)) => {
            status.branch = Some(branch.to_string());
            status.upstream = Some(upstream.to_string());
        }
        None => status.branch = Some(refs_part.to_string()),
    }

    if let Some(tracking) = tracking_part {
        for part in tracking.split(", ") {
            if let Some(n) = part.strip_prefix("ahead ") {
                status.ahead = n.parse().unwrap_or(0);
            } else if let Some(n) = part.strip_prefix("behind ") {
                status.behind = n.parse().unwrap_or(0);
            }
        }
    }
}

/// Branch and upstream tracking, without walking the worktree.
///
/// `git_status` answers this too, but it answers it by scanning every tracked
/// file — which is the expensive part of a status, and the status bar polls.
/// These three plumbing commands touch nothing but refs, so the poll costs the
/// same on a monorepo as on a toy.
///
/// The vocabulary is deliberately the porcelain header's, sentences and all:
/// `HEAD (no branch)` when detached and `No commits yet on <branch>` before the
/// first commit. It means the frontend has one shape to understand rather than
/// two, and `git_status` remains a drop-in for this call.
#[tauri::command(async)]
pub fn git_tracking(cwd: String) -> Result<RepoStatus, String> {
    let mut status = RepoStatus {
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
    };

    // `symbolic-ref` rather than `rev-parse --abbrev-ref HEAD`: it names the
    // branch even before its first commit, and fails cleanly when there is no
    // branch to name. `-q` keeps a detached HEAD off stderr, where it is not an
    // error worth reporting.
    let branch = git(&cwd, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .map(|out| out.trim().to_string())
        .filter(|name| !name.is_empty());
    let Some(branch) = branch else {
        // Not a branch. Whether that is a detached HEAD or not a repo at all is
        // the difference between having a HEAD and not, and only one of the two
        // is something to show.
        if git(&cwd, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok() {
            status.branch = Some("HEAD (no branch)".to_string());
        }
        return Ok(status);
    };

    // No commit yet: there is a branch, it just points at nothing, so there is
    // no upstream comparison to make either.
    if git(&cwd, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_err() {
        status.branch = Some(format!("No commits yet on {branch}"));
        return Ok(status);
    }
    status.branch = Some(branch);

    // No upstream is the ordinary state of a local branch, not a failure.
    let upstream = git(
        &cwd,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .ok()
    .map(|out| out.trim().to_string())
    .filter(|name| !name.is_empty());
    let Some(upstream) = upstream else {
        return Ok(status);
    };

    // `HEAD...@{u}` counts each side of the fork point: left is what is here and
    // not upstream, right is what is upstream and not here.
    let counts = git(&cwd, &["rev-list", "--left-right", "--count", "HEAD...@{u}"])?;
    let (ahead, behind) = parse_counts(&counts);
    status.upstream = Some(upstream);
    status.ahead = ahead;
    status.behind = behind;
    Ok(status)
}

/// `"2\t3"` from `rev-list --left-right --count`. Unparseable means zero rather
/// than an error: a count this app could not read is not a reason to lose the
/// branch name it came with.
fn parse_counts(out: &str) -> (u32, u32) {
    let mut fields = out.split_whitespace();
    let ahead = fields.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    let behind = fields.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

/// Byte ceiling on a returned patch. Far more than the viewer will render
/// (`Viewer.tsx` stops at 5000 lines), but small enough that the IPC hop and the
/// JSON encode stay imperceptible; a commit touching a generated file can
/// otherwise be hundreds of megabytes.
const PATCH_BUDGET_BYTES: u64 = 2 * 1024 * 1024;

/// Marker line appended when a patch is cut short. `Viewer.tsx` matches the
/// `… patch cut off at` prefix and shows it as a footer, so keep the two in sync.
/// No git output line can start with `…`, which makes the match unambiguous.
fn patch_cut_marker() -> String {
    format!("… patch cut off at {} MiB", PATCH_BUDGET_BYTES / (1024 * 1024))
}

/// Run git for a patch, reading at most `PATCH_BUDGET_BYTES` of stdout.
///
/// Unlike `git()` this never buffers the whole output: dropping the read end
/// makes git die on SIGPIPE instead of walking the rest of the diff, which also
/// means the exit status is only meaningful when nothing was cut.
///
/// `allow_diff_exit` tolerates exit 1, which `diff --no-index` uses to mean
/// "the files differ" rather than to report a failure.
fn git_patch(cwd: &str, args: &[&str], allow_diff_exit: bool) -> Result<String, String> {
    let mut child = crate::env::with_child_path(&mut Command::new("git"))
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run git: {e}"))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "git stdout was not captured".to_string())?;
    // One byte past the budget, so a patch ending exactly on it is not
    // reported as truncated.
    let mut bytes = Vec::new();
    let read = stdout
        .by_ref()
        .take(PATCH_BUDGET_BYTES + 1)
        .read_to_end(&mut bytes);
    drop(stdout);
    read.map_err(|e| format!("failed to read git output: {e}"))?;
    let cut = bytes.len() as u64 > PATCH_BUDGET_BYTES;

    // stdout is already closed, so this only drains stderr — at most a line for
    // these commands — and reaps the child.
    let rest = child
        .wait_with_output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    let differed = allow_diff_exit && rest.status.code() == Some(1);
    if !cut && !rest.status.success() && !differed {
        return Err(String::from_utf8_lossy(&rest.stderr).trim().to_string());
    }

    let mut patch = String::from_utf8_lossy(&bytes).into_owned();
    if cut {
        // Back off to a line boundary so the viewer never colourises half a line.
        patch.truncate(patch.rfind('\n').map_or(0, |nl| nl + 1));
        patch.push_str(&patch_cut_marker());
        patch.push('\n');
    }
    Ok(patch)
}

/// Full patch for one commit, capped at `PATCH_BUDGET_BYTES`.
#[tauri::command(async)]
pub fn git_show(cwd: String, sha: String) -> Result<String, String> {
    // The sha comes from the frontend: validate it and terminate option
    // parsing so a crafted value like `--output=/path` cannot become a flag.
    if sha.len() < 4 || sha.len() > 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("not a commit sha: {sha}"));
    }
    git_patch(
        &cwd,
        &["show", "--stat", "--patch", "--no-color", "--end-of-options", &sha],
        false,
    )
}

/// Diff for a single path, capped like `git_show`. `staged` selects the index
/// diff instead of the worktree one.
#[tauri::command(async)]
pub fn git_diff_file(cwd: String, path: String, staged: Option<bool>) -> Result<String, String> {
    let mut args = vec!["diff", "--no-color"];
    if staged.unwrap_or(false) {
        args.push("--cached");
    }
    args.push("--");
    args.push(&path);
    let patch = git_patch(&cwd, &args, false)?;
    if !patch.is_empty() {
        return Ok(patch);
    }
    // An untracked file has no tracked side to compare against, so `git diff`
    // says nothing at all about the one case where *every* line is new, and the
    // pane showed "(no textual diff)". Diff it against an empty file instead.
    // `--no-index` resolves `path` against `cwd`, which is the repo root the
    // porcelain status paths are already relative to.
    git_patch(
        &cwd,
        &["diff", "--no-color", "--no-index", "--", "/dev/null", &path],
        true,
    )
}

/// Local and remote branches, current branch first.
#[tauri::command(async)]
pub fn git_branches(cwd: String) -> Result<Vec<String>, String> {
    let stdout = git(
        &cwd,
        &["branch", "--all", "--sort=-committerdate", "--format=%(refname:short)"],
    )?;
    Ok(stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
}

/// Repository root for any path inside a worktree; `None` when not a repo.
#[tauri::command(async)]
pub fn git_root(cwd: String) -> Option<String> {
    git(&cwd, &["rev-parse", "--show-toplevel"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Reject a path list that git could read as options, and refuse an empty list
/// so a mistaken call can never widen to "every path in the repo".
///
/// Every caller also passes `--` before the paths; this is the second line of
/// defence, since the frontend sources these from `git_status` output.
fn checked_paths(paths: &[String]) -> Result<Vec<&str>, String> {
    if paths.is_empty() {
        return Err("no paths given".to_string());
    }
    paths
        .iter()
        .map(|p| {
            if p.is_empty() {
                Err("empty path".to_string())
            } else {
                Ok(p.as_str())
            }
        })
        .collect()
}

/// Whether HEAD resolves. False in a fresh repo before the first commit, where
/// the index has no committed side to be restored from.
fn has_head(cwd: &str) -> bool {
    git(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok()
}

/// Stage the given paths. `--` keeps a path such as `-x` a path, and `--all`
/// picks up deletions as well as edits and new files.
#[tauri::command(async)]
pub fn git_stage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let paths = checked_paths(&paths)?;
    let mut args = vec!["add", "--all", "--"];
    args.extend(paths);
    git(&cwd, &args).map(|_| ())
}

/// Unstage the given paths, leaving the worktree untouched.
#[tauri::command(async)]
pub fn git_unstage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let paths = checked_paths(&paths)?;
    // Before the first commit there is no HEAD to restore the index entry from,
    // so the only way back to "untracked" is to drop the entry outright.
    let mut args = if has_head(&cwd) {
        vec!["restore", "--staged", "--"]
    } else {
        vec!["rm", "--cached", "-r", "--quiet", "--"]
    };
    args.extend(paths);
    git(&cwd, &args).map(|_| ())
}

/// Commit what is staged. Returns git's own summary line for the status bar.
///
/// `amend` rewrites the previous commit instead of adding one, which is only
/// offered when HEAD exists and nothing has been pushed — the pane decides that.
#[tauri::command(async)]
pub fn git_commit(cwd: String, message: String, amend: Option<bool>) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("commit message is empty".to_string());
    }
    // `-m` consumes the next argument as its value, so a message starting with
    // `-` cannot be re-read as a flag.
    let mut args = vec!["commit", "-m", &message];
    if amend.unwrap_or(false) {
        args.push("--amend");
    }
    let stdout = git(&cwd, &args)?;
    Ok(stdout.trim().to_string())
}

/// Run git with every interactive credential path closed off.
///
/// A network command that decides to ask for a password would otherwise block
/// on a terminal this process does not have, and the whole call would hang until
/// the app is killed. Failing fast with git's own error is far better: the user
/// can fix their credential helper and retry.
fn git_network(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = crate::env::with_child_path(&mut Command::new("git"))
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        // Unset rather than set: an empty GIT_ASKPASS is still "run this", so
        // removing the variables is what actually disables the GUI prompters.
        .env_remove("GIT_ASKPASS")
        .env_remove("SSH_ASKPASS")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    // Progress goes to stderr even on success, so both streams are returned and
    // the caller shows whichever is non-empty.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(explain(&stderr));
    }
    let combined = format!("{}\n{}", stdout.trim(), stderr.trim());
    Ok(combined.trim().to_string())
}

/// A branch or remote name coming from the frontend. Rejects anything that
/// could be read as an option or escape the ref namespace, so a crafted name
/// cannot turn into a flag.
fn checked_ref(name: &str, what: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 255 {
        return Err(format!("not a {what}: {name}"));
    }
    if name.starts_with('-') || name.contains("..") || name.starts_with('/') {
        return Err(format!("not a {what}: {name}"));
    }
    let ok = name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/-_.+@".contains(&b));
    if ok {
        Ok(())
    } else {
        Err(format!("not a {what}: {name}"))
    }
}

/// `git fetch --prune`, so branch lists lose refs deleted upstream.
#[tauri::command(async)]
pub fn git_fetch(cwd: String, remote: Option<String>) -> Result<String, String> {
    let remote = remote.unwrap_or_default();
    // No `--no-tags`: git's default tag auto-following is what a user expects
    // from a fetch button, and `--prune` alone does not touch tags.
    let mut args = vec!["fetch", "--prune"];
    if !remote.is_empty() {
        checked_ref(&remote, "remote")?;
        args.push("--");
        args.push(&remote);
    } else {
        args.push("--all");
    }
    git_network(&cwd, &args)
}

/// Pull the current branch's upstream.
///
/// `--ff-only` by default: a pull that would have to merge, on a repo whose
/// worktree the user is mid-edit in, is exactly the case where an implicit
/// merge commit is the wrong answer. Pass `rebase` for the other behaviour.
#[tauri::command(async)]
pub fn git_pull(cwd: String, rebase: Option<bool>) -> Result<String, String> {
    let args: &[&str] = if rebase.unwrap_or(false) {
        &["pull", "--rebase"]
    } else {
        &["pull", "--ff-only"]
    };
    git_network(&cwd, args)
}

/// The remote to push a new branch to: `origin` when it exists, else the first
/// one configured. `None` when the repo has no remotes at all.
fn default_remote(cwd: &str) -> Option<String> {
    let remotes = git(cwd, &["remote"]).ok()?;
    let names: Vec<&str> = remotes
        .lines()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .collect();
    names
        .iter()
        .find(|r| **r == "origin")
        .or_else(|| names.first())
        .map(|r| r.to_string())
}

/// Push the current branch. `set_upstream` covers the first push of a new branch.
///
/// There is deliberately no force option: a forced push is not something the
/// sidebar should make a one-click action.
#[tauri::command(async)]
pub fn git_push(cwd: String, set_upstream: Option<bool>) -> Result<String, String> {
    if set_upstream.unwrap_or(false) {
        let remote = default_remote(&cwd).ok_or("this repository has no remote")?;
        // `HEAD` rather than a branch name from the frontend: the branch being
        // pushed is always the checked-out one, and git resolves the destination
        // name from it.
        return git_network(&cwd, &["push", "--set-upstream", &remote, "HEAD"]);
    }
    git_network(&cwd, &["push"])
}

/// Local and remote branch names plus the current one, for the branch menu.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
    pub current: Option<String>,
    pub local: Vec<String>,
    /// Remote-tracking branches, with the remote prefix kept (`origin/main`).
    pub remote: Vec<String>,
}

#[tauri::command(async)]
pub fn git_branch_list(cwd: String) -> Result<BranchList, String> {
    let format = "--format=%(refname:short)";
    let local = git(&cwd, &["branch", "--sort=-committerdate", format])?;
    let remote = git(&cwd, &["branch", "--remotes", "--sort=-committerdate", format])?;
    let current = git(&cwd, &["branch", "--show-current"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let lines = |s: String| -> Vec<String> {
        s.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            // `origin/HEAD -> origin/main` is a symref, not a branch to check out.
            .filter(|l| !l.contains("->"))
            .map(str::to_string)
            .collect()
    };

    Ok(BranchList {
        current,
        local: lines(local),
        remote: lines(remote),
    })
}

/// Whether a local branch by this exact name exists.
fn is_local_branch(cwd: &str, branch: &str) -> bool {
    git(cwd, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok()
}

/// For a remote-tracking name, the local branch name it corresponds to.
///
/// Derived by stripping an actual configured remote's prefix rather than
/// splitting on the first `/`, so `origin/feature/x` yields `feature/x` and a
/// local branch genuinely called `feature/x` is left alone.
fn local_name_for_remote(cwd: &str, branch: &str) -> Option<String> {
    let remotes = git(cwd, &["remote"]).ok()?;
    remotes
        .lines()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .find_map(|remote| branch.strip_prefix(&format!("{remote}/")))
        .filter(|rest| !rest.is_empty())
        .map(str::to_string)
}

/// Switch branches. Fails rather than discarding anything when the worktree
/// has changes that would be overwritten — git's own refusal is the guard.
///
/// `switch` rather than `checkout` on purpose: `checkout <name>` also accepts
/// paths, so a branch name that happens to match a file would silently discard
/// that file's changes instead of moving HEAD. `switch` only ever takes a branch.
#[tauri::command(async)]
pub fn git_checkout(cwd: String, branch: String) -> Result<String, String> {
    checked_ref(&branch, "branch")?;

    // Which form to use is decided by looking refs up, not by guessing from the
    // name: a local branch is very often called `feature/x`, and handing that to
    // `--track` creates a *new* local `x` tracking it rather than switching to
    // it — a silent wrong answer instead of an error.
    if is_local_branch(&cwd, &branch) {
        return git(&cwd, &["switch", "--", &branch]).map(|s| s.trim().to_string());
    }

    // A remote-tracking name whose local branch already exists: switch to the
    // local one. `--track` would refuse, and picking `origin/main` from the list
    // plainly means "work on main".
    if let Some(local) = local_name_for_remote(&cwd, &branch) {
        if is_local_branch(&cwd, &local) {
            return git(&cwd, &["switch", "--", &local]).map(|s| s.trim().to_string());
        }
    }

    // Otherwise create the local branch with its upstream already set.
    git(&cwd, &["switch", "--track", "--", &branch]).map(|s| s.trim().to_string())
}

/// Create a branch at HEAD and switch to it.
#[tauri::command(async)]
pub fn git_create_branch(cwd: String, name: String) -> Result<String, String> {
    checked_ref(&name, "branch name")?;
    git(&cwd, &["switch", "--create", &name]).map(|s| s.trim().to_string())
}

/// Merge `branch` into the current one. `--no-commit` is not used: the default
/// behaviour (fast-forward when possible, merge commit otherwise) is what the
/// VSCode SCM menu does, and a conflict is left in the worktree to resolve.
#[tauri::command(async)]
pub fn git_merge(cwd: String, branch: String) -> Result<String, String> {
    checked_ref(&branch, "branch")?;
    let stdout = git(&cwd, &["merge", "--no-edit", "--end-of-options", &branch])?;
    Ok(stdout.trim().to_string())
}

/// Throw away worktree changes for the given paths, and delete untracked files
/// among them. Irreversible — the pane confirms before calling this.
///
/// `restore --worktree` covers tracked files; an untracked path has nothing to
/// restore from, so it is removed instead. Which is which comes from the caller's
/// own status read, passed as two separate lists so this never has to guess.
#[tauri::command(async)]
pub fn git_discard(cwd: String, tracked: Vec<String>, untracked: Vec<String>) -> Result<(), String> {
    if tracked.is_empty() && untracked.is_empty() {
        return Err("no paths given".to_string());
    }
    if !tracked.is_empty() {
        let paths = checked_paths(&tracked)?;
        let mut args = vec!["restore", "--worktree", "--"];
        args.extend(paths);
        git(&cwd, &args)?;
    }
    if !untracked.is_empty() {
        let paths = checked_paths(&untracked)?;
        // `-ff` also removes nested untracked repositories, which `-f` refuses;
        // without it a stray clone makes the whole call fail.
        let mut args = vec!["clean", "-ffdq", "--"];
        args.extend(paths);
        git(&cwd, &args)?;
    }
    Ok(())
}

#[cfg(test)]
mod tracking_tests {
    use super::*;
    use std::path::{Path, PathBuf};

    /// Per-test scratch directory, removed and recreated so a rerun starts clean.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mangouste-git-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// Run git, failing the test with git's own message rather than a unit error.
    fn run(cwd: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .expect("run git");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// An empty repo on a known branch name, whatever the host's default is.
    fn repo(name: &str) -> PathBuf {
        let dir = scratch(name);
        run(&dir, &["init", "--quiet", "--initial-branch=main", "."]);
        dir
    }

    fn commit(dir: &Path, text: &str) {
        std::fs::write(dir.join("f.txt"), text).expect("write");
        run(dir, &["add", "f.txt"]);
        run(dir, &["commit", "--quiet", "-m", text]);
    }

    fn tracking(dir: &Path) -> RepoStatus {
        git_tracking(dir.to_string_lossy().into_owned()).expect("tracking")
    }

    #[test]
    fn a_branch_with_no_commits_keeps_its_name() {
        // `rev-parse --abbrev-ref HEAD` fails outright here, which is the reason
        // the branch is read with `symbolic-ref`.
        let dir = repo("unborn");
        let status = tracking(&dir);
        assert_eq!(status.branch.as_deref(), Some("No commits yet on main"));
        assert_eq!(status.upstream, None);
    }

    #[test]
    fn a_branch_with_no_upstream_is_not_a_failure() {
        let dir = repo("no-upstream");
        commit(&dir, "one");
        let status = tracking(&dir);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream, None);
        assert_eq!((status.ahead, status.behind), (0, 0));
    }

    #[test]
    fn a_detached_head_has_a_branch_of_no_branch() {
        let dir = repo("detached");
        commit(&dir, "one");
        commit(&dir, "two");
        run(&dir, &["checkout", "--quiet", "HEAD~1"]);
        let status = tracking(&dir);
        assert_eq!(status.branch.as_deref(), Some("HEAD (no branch)"));
        assert_eq!(status.upstream, None);
    }

    #[test]
    fn outside_a_repository_there_is_no_branch_at_all() {
        // Distinct from a detached HEAD, which has one to show.
        let dir = scratch("not-a-repo");
        let status = tracking(&dir);
        assert_eq!(status.branch, None);
    }

    #[test]
    fn each_side_of_the_fork_point_is_counted() {
        // A clone, so `@{u}` is configured the way it is in a real checkout.
        let origin = repo("counts-origin");
        commit(&origin, "one");
        commit(&origin, "two");
        let clone = scratch("counts-clone").join("work");
        run(
            Path::new("/tmp"),
            &[
                "clone",
                "--quiet",
                &origin.to_string_lossy(),
                &clone.to_string_lossy(),
            ],
        );

        let level = tracking(&clone);
        assert_eq!(level.upstream.as_deref(), Some("origin/main"));
        assert_eq!((level.ahead, level.behind), (0, 0));

        // Two more upstream, one of our own, fetched but not merged: the
        // diverged case the status bar must not offer a fast-forward for.
        commit(&origin, "three");
        commit(&origin, "four");
        commit(&clone, "mine");
        run(&clone, &["fetch", "--quiet", "origin"]);
        let diverged = tracking(&clone);
        assert_eq!((diverged.ahead, diverged.behind), (1, 2));
    }

    #[test]
    fn an_unreadable_count_keeps_the_branch_it_came_with() {
        assert_eq!(parse_counts("2\t3\n"), (2, 3));
        assert_eq!(parse_counts(""), (0, 0));
        assert_eq!(parse_counts("wat"), (0, 0));
    }
}
