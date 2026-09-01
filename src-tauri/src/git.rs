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

/// What a history query is narrowed to. Every field is optional, and the ones
/// that are set are AND-ed together.
///
/// One struct rather than four more positional parameters: Tauri passes a
/// command its arguments by name, so a fifth filter added later is a field here
/// and not a signature every caller has to be re-read against.
#[derive(Debug, Default, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFilter {
    /// Substring of the author name or email.
    pub author: Option<String>,
    /// Substring of the commit message.
    pub text: Option<String>,
    /// Only commits that touched this path.
    pub path: Option<String>,
    /// Walk from this ref instead of from every ref.
    pub branch: Option<String>,
}

/// A filter field with something in it, or None. The pane sends the empty
/// string for a field the user has cleared, and `--author=` matches every
/// commit rather than none — so blank has to mean absent here, not "match on
/// nothing".
fn filled(value: &Option<String>) -> Option<&str> {
    let text = value.as_deref()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
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
    filter: Option<LogFilter>,
) -> Result<Vec<Commit>, String> {
    let filter = filter.unwrap_or_default();
    let format = format!(
        "--pretty=format:%H{sep}%h{sep}%an{sep}%ae{sep}%at{sep}%P{sep}%D{sep}%s",
        sep = FIELD_SEPARATOR
    );

    let mut args: Vec<String> = vec![
        "log".into(),
        "--date-order".into(),
        "-n".into(),
        limit.unwrap_or(200).to_string(),
        "--skip".into(),
        skip.unwrap_or(0).to_string(),
        format,
    ];

    // `--fixed-strings` and `--regexp-ignore-case` apply to `--author` and
    // `--grep` alike: without them a name with a `.` or a `+` in it is a regex,
    // and typing one into a filter box is not asking for one.
    if filled(&filter.author).is_some() || filled(&filter.text).is_some() {
        args.push("--fixed-strings".into());
        args.push("--regexp-ignore-case".into());
    }
    if let Some(author) = filled(&filter.author) {
        args.push(format!("--author={author}"));
    }
    if let Some(text) = filled(&filter.text) {
        args.push(format!("--grep={text}"));
    }

    // A branch narrows the walk to one starting point, which is the opposite of
    // `--all`; asking for both would widen it straight back out again.
    match filled(&filter.branch) {
        Some(branch) => {
            checked_ref(branch, "branch")?;
            args.push("--end-of-options".into());
            args.push(branch.to_string());
        }
        None if all_branches.unwrap_or(true) => args.push("--all".into()),
        None => {}
    }

    // Last, and after `--`, so a path beginning with a dash stays a path.
    if let Some(path) = filled(&filter.path) {
        args.push("--".into());
        args.push(path.to_string());
    }

    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let stdout = git(&cwd, &borrowed)?;
    let commits = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(parse_commit)
        .collect();
    Ok(commits)
}

/// One `git log` record, or None when the line is not one.
fn parse_commit(line: &str) -> Option<Commit> {
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

/// Whether anything is uncommitted: the `*` VSCode puts beside the branch.
///
/// `--untracked-files=no` deliberately. Walking for untracked files is the
/// expensive half of a status — it descends directories git has nothing recorded
/// for — and this is polled. The cost of leaving it out is that a repo whose only
/// change is a brand new file reads as clean, which is the wrong answer; the cost
/// of leaving it in is a directory crawl every few seconds on a monorepo. The
/// marker is a hint, so it is the cheap one.
#[tauri::command(async)]
pub fn git_dirty(cwd: String) -> Result<bool, String> {
    // Porcelain rather than `diff --quiet HEAD`, which needs a HEAD to compare
    // against: this answers on an unborn branch and a detached one alike, and
    // costs the same now that the untracked walk is off.
    let stdout = git(&cwd, &["status", "--porcelain", "--untracked-files=no"])?;
    Ok(!stdout.trim().is_empty())
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

/// The sha came from the frontend: validate it, and pair every use with
/// `--end-of-options`, so a crafted value like `--output=/path` can neither
/// reach git nor become a flag if it did.
fn checked_sha(sha: &str) -> Result<(), String> {
    if sha.len() < 4 || sha.len() > 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("not a commit sha: {sha}"));
    }
    Ok(())
}

/// Full patch for one commit, capped at `PATCH_BUDGET_BYTES`.
#[tauri::command(async)]
pub fn git_show(cwd: String, sha: String) -> Result<String, String> {
    checked_sha(&sha)?;
    git_patch(
        &cwd,
        &["show", "--stat", "--patch", "--no-color", "--end-of-options", &sha],
        false,
    )
}

/// Patch for one path inside one commit, which is what clicking a file in the
/// history pane asks for. `git show <sha>` on a 40-file commit is a megabyte of
/// patch to read one hunk out of.
#[tauri::command(async)]
pub fn git_show_file(cwd: String, sha: String, path: String) -> Result<String, String> {
    checked_sha(&sha)?;
    if path.is_empty() {
        return Err("empty path".to_string());
    }
    git_patch(
        &cwd,
        &[
            "show",
            "--no-color",
            "--format=",
            "-M",
            // A merge shows nothing by default — its combined diff is empty
            // unless the merge had conflicts — so a file changed on the branch
            // that was merged would list here and then open blank. Diffing
            // against the first parent is what a history view means by "what
            // this commit did".
            "-m",
            "--first-parent",
            "--end-of-options",
            &sha,
            "--",
            &path,
        ],
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

/// One changed file inside a commit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    /// Raw status letter, e.g. `M`, `A`, `D`, `R100`.
    pub status: String,
    /// Post-image path, which is the one to ask for a patch by.
    pub path: String,
    /// Pre-image path, present only for a rename or a copy.
    pub original_path: Option<String>,
    /// None for a binary file, which git counts as `-` rather than as 0.
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

/// Everything the history pane's right-hand side shows for one commit.
///
/// One command rather than three: selecting a row in a list is a keyboard
/// repeat away from selecting forty of them, and each extra round trip is
/// another git process per row travelled through.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub commit: Commit,
    /// The message below the subject line, trailing blank lines trimmed.
    pub body: String,
    pub committer: String,
    pub committer_email: String,
    pub commit_timestamp: i64,
    pub files: Vec<CommitFile>,
}

/// Split `git show --raw --numstat -z` into one record per changed file.
///
/// The two formats come out of a single git call, raw section first: `-z` makes
/// every field NUL-terminated, so a path with a newline or a quote in it needs
/// no unquoting and cannot be mistaken for the start of the next record. A raw
/// record opens with `:`, a numstat one with a count, which is what tells the
/// sections apart without counting them.
fn parse_commit_files(out: &str) -> Vec<CommitFile> {
    let tokens: Vec<&str> = out.split('\0').filter(|t| !t.is_empty()).collect();
    let mut files: Vec<CommitFile> = Vec::new();
    let mut index = 0;

    while index < tokens.len() {
        let token = tokens[index];
        if let Some(meta) = token.strip_prefix(':') {
            // `:<oldmode> <newmode> <oldsha> <newsha> <status>`, then the path,
            // then a second path when the status is a rename or a copy.
            let status = meta.split_whitespace().last().unwrap_or("").to_string();
            let renamed = status.starts_with('R') || status.starts_with('C');
            let paths = if renamed { 2 } else { 1 };
            if index + paths >= tokens.len() {
                break;
            }
            let (original_path, path) = if renamed {
                (Some(tokens[index + 1].to_string()), tokens[index + 2].to_string())
            } else {
                (None, tokens[index + 1].to_string())
            };
            files.push(CommitFile {
                status,
                path,
                original_path,
                additions: None,
                deletions: None,
            });
            index += paths + 1;
            continue;
        }

        // `<adds>\t<dels>\t<path>`, or `<adds>\t<dels>\t` followed by the two
        // paths of a rename as their own tokens.
        let mut parts = token.splitn(3, '\t');
        let adds = parts.next().unwrap_or("");
        let dels = parts.next().unwrap_or("");
        let inline = parts.next().unwrap_or("");
        let mut consumed = 1;
        let path = if inline.is_empty() {
            if index + 2 >= tokens.len() {
                break;
            }
            consumed = 3;
            tokens[index + 2].to_string()
        } else {
            inline.to_string()
        };
        if let Some(file) = files.iter_mut().find(|f| f.path == path) {
            file.additions = adds.parse().ok();
            file.deletions = dels.parse().ok();
        }
        index += consumed;
    }

    files
}

/// Message, committer and changed files for one commit.
#[tauri::command(async)]
pub fn git_commit_detail(cwd: String, sha: String) -> Result<CommitDetail, String> {
    checked_sha(&sha)?;
    let format = format!(
        "--pretty=format:%H{sep}%h{sep}%an{sep}%ae{sep}%at{sep}%P{sep}%D{sep}%s{sep}%cn{sep}%ce{sep}%ct{sep}%b",
        sep = FIELD_SEPARATOR
    );
    let header = git(
        &cwd,
        &["log", "-1", &format, "--end-of-options", &sha],
    )?;

    // `splitn` and not `split`: the body is last precisely because it is the one
    // field that can hold anything, separator bytes included.
    let fields: Vec<&str> = header.splitn(12, FIELD_SEPARATOR).collect();
    if fields.len() < 12 {
        return Err(format!("no such commit: {sha}"));
    }
    let commit = parse_commit(&fields[..8].join(&FIELD_SEPARATOR.to_string()))
        .ok_or_else(|| format!("no such commit: {sha}"))?;

    let files = parse_commit_files(&git(
        &cwd,
        &[
            "show",
            "--format=",
            "--raw",
            "--numstat",
            "-M",
            "-m",
            "--first-parent",
            "-z",
            "--end-of-options",
            &sha,
        ],
    )?);

    Ok(CommitDetail {
        commit,
        body: fields[11].trim_end().to_string(),
        committer: fields[8].to_string(),
        committer_email: fields[9].to_string(),
        commit_timestamp: fields[10].parse().unwrap_or(0),
        files,
    })
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

/* ---------- blame ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommit {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    pub author_email: String,
    pub timestamp: i64,
    pub summary: String,
}

/// One file's blame, as a commit table plus one index per line.
///
/// Indices rather than a sha on every line: a long file blames to a handful of
/// commits, and repeating a 40-character sha per line makes the payload for a
/// 5000-line file an order of magnitude bigger than the file itself.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blame {
    pub commits: Vec<BlameCommit>,
    /// Index into `commits`, one per line of the worktree file, in order.
    pub lines: Vec<usize>,
}

/**
 * Ceiling on blamed lines.
 *
 * The frontend puts one DOM node per line with no virtualisation, so blame on a
 * generated file — a lockfile, a snapshot — would otherwise be tens of thousands
 * of nodes for a column nobody reads to the bottom of. Past this the column runs
 * out, which is visible rather than silent, and costs nothing.
 */
const MAX_BLAME_LINES: usize = 20_000;

/// Whether a token is an object name: 40 hex characters for sha1, 64 for sha256.
fn is_object_name(token: &str) -> bool {
    token.len() >= 40 && token.chars().all(|c| c.is_ascii_hexdigit())
}

/// Who last touched each line of a file, for the editor's blame column.
///
/// Takes a path rather than a repo and a relative path: the caller is an open
/// editor, which knows the absolute path of the file it is showing and nothing
/// about which repo root it belongs to. git resolves the repo from the directory
/// the command runs in, which is the file's own.
///
/// Blames the worktree file, so uncommitted lines come back under the all-zero
/// sha that git gives them — the frontend shows those as uncommitted rather than
/// hiding them, since "this line is mine and unsaved" is the useful answer.
#[tauri::command(async)]
pub fn git_blame(path: String) -> Result<Blame, String> {
    let dir = std::path::Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "no directory to run git in".to_string())?;

    // `--porcelain` repeats a commit's details only the first time it appears,
    // which is what makes the commit table below cheap to build.
    let stdout = git(&dir, &["blame", "--porcelain", "--", &path])?;

    let mut commits: Vec<BlameCommit> = Vec::new();
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut lines: Vec<usize> = Vec::new();
    // Which commit the record being read belongs to, until its content line.
    let mut current: Option<usize> = None;

    for raw in stdout.lines() {
        // The line's own text, which closes the record it belongs to. Tab is the
        // only prefix git uses for content, so this cannot collide with a header.
        if raw.starts_with('\t') {
            if let Some(at) = current.take() {
                lines.push(at);
                if lines.len() >= MAX_BLAME_LINES {
                    break;
                }
            }
            continue;
        }

        let mut fields = raw.splitn(2, ' ');
        let first = fields.next().unwrap_or("");
        let rest = fields.next().unwrap_or("");

        // A header is `<sha> <orig-line> <final-line> [<lines-in-group>]`. Both
        // halves are checked, because `previous <sha> <file>` also carries an
        // object name and must not be read as the start of a new record.
        let numbered = rest
            .split(' ')
            .next()
            .is_some_and(|n| !n.is_empty() && n.parse::<u32>().is_ok());
        if is_object_name(first) && numbered {
            let at = match seen.get(first) {
                Some(&at) => at,
                None => {
                    commits.push(BlameCommit {
                        sha: first.to_string(),
                        short_sha: first.chars().take(8).collect(),
                        author: String::new(),
                        author_email: String::new(),
                        timestamp: 0,
                        summary: String::new(),
                    });
                    seen.insert(first.to_string(), commits.len() - 1);
                    commits.len() - 1
                }
            };
            current = Some(at);
            continue;
        }

        // Everything else is a header field for the record being read. Only the
        // first record for a commit carries them, so nothing overwrites what is
        // already there — a later group repeats the sha line and nothing else.
        let Some(at) = current else { continue };
        let commit = &mut commits[at];
        match first {
            "author" if commit.author.is_empty() => commit.author = rest.to_string(),
            "author-mail" if commit.author_email.is_empty() => {
                commit.author_email = rest.trim_matches(|c| c == '<' || c == '>').to_string();
            }
            "author-time" if commit.timestamp == 0 => {
                commit.timestamp = rest.trim().parse().unwrap_or(0);
            }
            "summary" if commit.summary.is_empty() => commit.summary = rest.to_string(),
            _ => {}
        }
    }

    Ok(Blame { commits, lines })
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
    fn dirty_sees_tracked_changes_and_not_untracked_ones() {
        let dir = repo("dirty");
        commit(&dir, "one");
        let cwd = dir.to_string_lossy().into_owned();
        assert!(!git_dirty(cwd.clone()).unwrap());

        // A worktree edit, then the same edit staged: both are uncommitted work.
        std::fs::write(dir.join("f.txt"), "changed").expect("write");
        assert!(git_dirty(cwd.clone()).unwrap());
        run(&dir, &["add", "f.txt"]);
        assert!(git_dirty(cwd.clone()).unwrap());
        run(&dir, &["commit", "--quiet", "-m", "two"]);
        assert!(!git_dirty(cwd.clone()).unwrap());

        // The documented cost of skipping the untracked walk: a brand new file
        // reads as clean. Pinned so the trade is a decision, not a surprise.
        std::fs::write(dir.join("new.txt"), "hello").expect("write");
        assert!(!git_dirty(cwd).unwrap());
    }

    #[test]
    fn dirty_answers_on_a_branch_with_no_commits() {
        // `diff --quiet HEAD` cannot: there is no HEAD to compare against, which
        // is why this reads porcelain instead.
        let dir = repo("dirty-unborn");
        let cwd = dir.to_string_lossy().into_owned();
        assert!(!git_dirty(cwd.clone()).unwrap());
        std::fs::write(dir.join("f.txt"), "staged").expect("write");
        run(&dir, &["add", "f.txt"]);
        assert!(git_dirty(cwd).unwrap());
    }

    #[test]
    fn blame_names_the_commit_behind_each_line() {
        let dir = repo("blame");
        std::fs::write(dir.join("f.txt"), "one\ntwo\n").expect("write");
        run(&dir, &["add", "f.txt"]);
        run(&dir, &["commit", "--quiet", "-m", "first"]);
        std::fs::write(dir.join("f.txt"), "one\ntwo\nthree\n").expect("write");
        run(&dir, &["add", "f.txt"]);
        run(&dir, &["commit", "--quiet", "-m", "second"]);

        let blame = git_blame(dir.join("f.txt").to_string_lossy().into_owned()).expect("blame");
        assert_eq!(blame.lines.len(), 3);
        // Two lines from the first commit, one from the second, and each commit
        // carried once: the whole point of the index-per-line shape.
        assert_eq!(blame.commits.len(), 2);
        assert_eq!(blame.lines[0], blame.lines[1]);
        assert_ne!(blame.lines[0], blame.lines[2]);
        let first = &blame.commits[blame.lines[0]];
        assert_eq!(first.summary, "first");
        assert_eq!(first.author, "t");
        assert_eq!(first.author_email, "t@t");
        assert_eq!(first.short_sha.len(), 8);
        assert!(first.sha.starts_with(&first.short_sha));
        assert!(first.timestamp > 0);
        assert_eq!(blame.commits[blame.lines[2]].summary, "second");
    }

    #[test]
    fn an_unsaved_line_blames_to_the_all_zero_sha() {
        // git's own marker for "not committed yet", which the editor shows as
        // uncommitted rather than hiding — it is the line you just typed.
        let dir = repo("blame-dirty");
        std::fs::write(dir.join("f.txt"), "one\n").expect("write");
        run(&dir, &["add", "f.txt"]);
        run(&dir, &["commit", "--quiet", "-m", "first"]);
        std::fs::write(dir.join("f.txt"), "one\nmine\n").expect("write");

        let blame = git_blame(dir.join("f.txt").to_string_lossy().into_owned()).expect("blame");
        assert_eq!(blame.lines.len(), 2);
        let mine = &blame.commits[blame.lines[1]];
        assert!(mine.sha.chars().all(|c| c == '0'), "{}", mine.sha);
    }

    #[test]
    fn a_path_git_cannot_blame_fails_with_gits_own_words() {
        let dir = repo("blame-untracked");
        std::fs::write(dir.join("f.txt"), "one\n").expect("write");
        run(&dir, &["add", "f.txt"]);
        run(&dir, &["commit", "--quiet", "-m", "first"]);
        std::fs::write(dir.join("new.txt"), "hello\n").expect("write");

        let error = git_blame(dir.join("new.txt").to_string_lossy().into_owned())
            .expect_err("untracked");
        assert!(error.contains("no such path"), "{error}");
    }

    #[test]
    fn an_unreadable_count_keeps_the_branch_it_came_with() {
        assert_eq!(parse_counts("2\t3\n"), (2, 3));
        assert_eq!(parse_counts(""), (0, 0));
        assert_eq!(parse_counts("wat"), (0, 0));
    }

    #[test]
    fn a_renamed_file_keeps_both_of_its_names() {
        // Raw section then numstat section, exactly as `-z` emits them: a
        // rename spends three tokens in each, and a binary file counts `-`.
        let out = concat!(
            ":100644 100644 aaa bbb R096\0old.txt\0new.txt\0",
            ":100644 100644 ccc ddd M\0keep.rs\0",
            ":100644 100644 eee fff M\0logo.png\0",
            "3\t1\t\0old.txt\0new.txt\0",
            "9\t2\tkeep.rs\0",
            "-\t-\tlogo.png\0",
        );
        let files = parse_commit_files(out);

        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "new.txt");
        assert_eq!(files[0].original_path.as_deref(), Some("old.txt"));
        assert_eq!(files[0].additions, Some(3));
        assert_eq!(files[1].additions, Some(9));
        assert_eq!(files[1].deletions, Some(2));
        // A binary file has no line counts at all, which is not the same
        // number as zero and must not render as one.
        assert_eq!(files[2].additions, None);
    }

    #[test]
    fn a_commits_detail_carries_its_body_and_its_files() {
        let dir = repo("detail");
        commit(&dir, "first");
        std::fs::write(dir.join("g.txt"), "new\n").expect("write");
        run(&dir, &["add", "g.txt"]);
        run(&dir, &["commit", "--quiet", "-m", "second", "-m", "why it was done"]);
        let sha = run(&dir, &["rev-parse", "HEAD"]).trim().to_string();

        let detail = git_commit_detail(dir.to_string_lossy().into_owned(), sha.clone())
            .expect("detail");

        assert_eq!(detail.commit.sha, sha);
        assert_eq!(detail.commit.subject, "second");
        assert_eq!(detail.body, "why it was done");
        assert_eq!(detail.committer_email, "t@t");
        let paths: Vec<&str> = detail.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["g.txt"]);
        assert_eq!(detail.files[0].status, "A");
        assert_eq!(detail.files[0].additions, Some(1));
    }

    #[test]
    fn a_sha_that_is_not_one_never_reaches_git() {
        let dir = repo("sha-guard");
        commit(&dir, "first");

        let error = git_commit_detail(dir.to_string_lossy().into_owned(), "--output=/x".into())
            .expect_err("rejected");
        assert!(error.contains("not a commit sha"), "{error}");
        let error = git_show_file(
            dir.to_string_lossy().into_owned(),
            "HEAD".into(),
            "f.txt".into(),
        )
        .expect_err("rejected");
        assert!(error.contains("not a commit sha"), "{error}");
    }

    #[test]
    fn a_message_filter_matches_as_text_and_not_as_a_regex() {
        let dir = repo("log-filter");
        commit(&dir, "plain");
        commit(&dir, "fix(a.b): thing");

        let matched = git_log(
            dir.to_string_lossy().into_owned(),
            None,
            None,
            Some(true),
            Some(LogFilter { text: Some("fix(a.b)".into()), ..LogFilter::default() }),
        )
        .expect("log");
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].subject, "fix(a.b): thing");

        // `.` is a literal here. As a regex it would have matched `axb` too,
        // and a filter box that quietly accepts regexes is a filter box that
        // quietly drops commits.
        let none = git_log(
            dir.to_string_lossy().into_owned(),
            None,
            None,
            Some(true),
            Some(LogFilter { text: Some("fix(axb)".into()), ..LogFilter::default() }),
        )
        .expect("log");
        assert!(none.is_empty(), "{none:?}");
    }

    #[test]
    fn a_blank_filter_field_is_not_a_filter() {
        let dir = repo("log-blank");
        commit(&dir, "first");
        commit(&dir, "second");

        let all = git_log(
            dir.to_string_lossy().into_owned(),
            None,
            None,
            Some(true),
            Some(LogFilter {
                author: Some("  ".into()),
                text: Some("".into()),
                ..LogFilter::default()
            }),
        )
        .expect("log");
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn a_path_filter_keeps_only_the_commits_that_touched_it() {
        let dir = repo("log-path");
        commit(&dir, "first");
        std::fs::write(dir.join("other.txt"), "x\n").expect("write");
        run(&dir, &["add", "other.txt"]);
        run(&dir, &["commit", "--quiet", "-m", "other"]);

        let touched = git_log(
            dir.to_string_lossy().into_owned(),
            None,
            None,
            Some(true),
            Some(LogFilter { path: Some("other.txt".into()), ..LogFilter::default() }),
        )
        .expect("log");
        assert_eq!(touched.len(), 1);
        assert_eq!(touched[0].subject, "other");
    }
}
