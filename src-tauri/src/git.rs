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

fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
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
    let mut child = Command::new("git")
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
