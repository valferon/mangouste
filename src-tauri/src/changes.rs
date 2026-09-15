//! What a session has done to the code, as a diff, while it is still doing it.
//!
//! The transcript already renders every `Edit` as a diff card in the chat, and
//! that is the right thing when you are reading a turn. It is the wrong thing
//! when you are watching eight sessions: the cards are scattered through pages
//! of tool output, an edit rewritten three times reads as three changes rather
//! than one, and a change made through `Bash` — `sed`, `git apply`, a formatter,
//! codegen — does not appear as a diff at all, because no `Edit` call was made.
//!
//! So the answer to "what has this session changed" is taken from disk, not from
//! the transcript. Git holds the net effect of everything, whoever wrote it and
//! however many attempts it took.
//!
//! Two facts have to be supplied for that to mean *this session*:
//!
//!   * **Which paths.** The repo's dirty pile belongs to every session in it,
//!     plus whatever you edited by hand. The transcript's write-set is the
//!     narrowing, and `recap::session_writes` already folds it incrementally, so
//!     the filter costs a cache lookup on every call after the first.
//!   * **Which baseline.** A session that has committed has moved its own work
//!     out of the dirty pile, so diffing against `HEAD` would show nothing it
//!     did before the commit. The parent of its first commit is where it
//!     started; a session that has committed nothing starts at `HEAD`.
//!
//! The path filter is what this cannot do perfectly, and the limit is worth
//! stating: a file two sessions both edited shows both their work, because git
//! knows the file changed and not who changed it. The rail's own collision
//! signal is the answer to that, not a heuristic here that would have to guess.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::recap::{session_writes, RecapCache, SessionWrites};

/// Files listed in one scan.
///
/// A session that touched more than this is a session whose diff nobody is
/// reading file by file; the count comes back so the pane can say what it left
/// out. Generous because the cost is one `git diff --numstat`, not a patch per
/// file.
const MAX_FILES: usize = 200;

/// One file the session changed, as git counts it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Repo-relative, which is what the patch headers and the status porcelain
    /// both use, and what a pane wants to print.
    pub path: String,
    /// None for a binary file, which git's numstat reports as `-`.
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    /// No tracked side to diff against, so the patch comes from `--no-index`.
    pub untracked: bool,
    /// When the session last wrote it, from the transcript. Zero when the write
    /// came from a tool that names no path — a `Bash` heredoc, a formatter — in
    /// which case git found the change and the transcript cannot date it.
    pub last_touch_ms: u64,
    /// Times the session called a write tool on it. Zero for the same reason.
    pub touches: u64,
}

/// Everything the changes pane shows for one session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionChanges {
    /// The commit the diff is taken against.
    pub base: String,
    /// How that baseline was chosen, for the pane to print: `HEAD`, or the
    /// session's first commit.
    pub base_label: String,
    pub files: Vec<ChangedFile>,
    /// Files before the `MAX_FILES` cap.
    pub file_count: u64,
    pub additions: u64,
    pub deletions: u64,
    /// Paths the transcript claims the session wrote that git reports as
    /// unchanged — reverted, or written back to what they already said.
    pub unchanged: u64,
    /// When the newest turn began, so the pane can offer a scope narrower than
    /// the whole session. Zero before the first prompt.
    pub turn_start_ms: u64,
}

fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    crate::git::git_out(cwd, args)
}

/// Resolve a revision to a commit sha, or None when git does not know it.
///
/// Used rather than trusting the transcript: the sha in a recap came out of
/// what `git commit` printed inside the session, and that commit can since have
/// been amended, rebased away, or made in a different repo entirely.
fn resolve(cwd: &str, rev: &str) -> Option<String> {
    let out = git(cwd, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")]).ok()?;
    let sha = out.trim();
    if sha.is_empty() {
        None
    } else {
        Some(sha.to_string())
    }
}

/// Where the session's work starts.
///
/// The parent of its first commit, when it has one that still resolves and is
/// not a root commit. `HEAD` otherwise — which is also the answer for the common
/// case of a session that has changed files and committed nothing.
fn baseline(cwd: &str, first_commit: Option<&str>) -> Result<(String, String), String> {
    if let Some(sha) = first_commit {
        if let Some(parent) = resolve(cwd, &format!("{sha}^")) {
            return Ok((parent, format!("before {}", short(sha))));
        }
        // A root commit has no parent, so the session's work starts at the empty
        // tree. git's well-known empty-tree object is a valid diff argument and
        // needs no repo of its own to exist in.
        if resolve(cwd, sha).is_some() {
            return Ok((EMPTY_TREE.to_string(), "the empty repo".to_string()));
        }
    }
    let head = resolve(cwd, "HEAD").ok_or_else(|| "this repo has no commits yet".to_string())?;
    Ok((head, "HEAD".to_string()))
}

/// git's empty tree, the same in every repository.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// `123\t4\tsrc/x.ts` per line; `-` in either column means a binary file.
fn parse_numstat(line: &str) -> Option<(Option<u32>, Option<u32>, String)> {
    let mut fields = line.splitn(3, '\t');
    let adds = fields.next()?;
    let dels = fields.next()?;
    let path = fields.next()?;
    if path.is_empty() {
        return None;
    }
    Some((adds.parse().ok(), dels.parse().ok(), path.to_string()))
}

/// Paths, as git wants them: relative to the repo root, and existing.
///
/// The transcript records absolute paths, and a session's cwd is not always the
/// repo root — `claude` started in `packages/web` writes
/// `/home/me/repo/packages/web/src/x.ts` while git wants `packages/web/src/x.ts`
/// from the root. Anything outside the repo is dropped rather than passed to
/// git, which would fail the whole command over one stray path.
fn relative_paths(root: &Path, absolute: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for path in absolute {
        let candidate = PathBuf::from(path);
        let Ok(relative) = candidate.strip_prefix(root) else { continue };
        let text = relative.to_string_lossy().to_string();
        if !text.is_empty() {
            out.push(text);
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Untracked files among the given paths.
///
/// `git diff` says nothing at all about a file git has never seen, which is
/// exactly the case where every line is new — a file the session created. The
/// status porcelain is the only thing that knows they exist.
fn untracked_among(cwd: &str, paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let mut args = vec!["status", "--porcelain=v1", "-z", "--untracked-files=all", "--"];
    args.extend(paths.iter().map(String::as_str));
    let stdout = git(cwd, &args)?;
    Ok(stdout
        .split('\0')
        .filter(|record| record.len() > 3 && record.starts_with("??"))
        .map(|record| record[3..].to_string())
        .collect())
}

/// Lines in an untracked file, counted as additions.
///
/// `--no-index` against `/dev/null` is what `git_diff_file` already uses to show
/// a new file's patch; numstat of the same comparison is its line count.
fn untracked_numstat(cwd: &str, path: &str) -> (Option<u32>, Option<u32>) {
    let out = crate::git::git_diff_out(
        cwd,
        &["diff", "--numstat", "--no-index", "--", "/dev/null", path],
    );
    out.ok()
        .and_then(|text| text.lines().next().and_then(parse_numstat))
        .map(|(adds, dels, _)| (adds, dels))
        .unwrap_or((None, None))
}

/// The git half, with the transcript's write-set already folded.
///
/// Split from the command so it can be tested against a real repository:
/// everything subtle here — which baseline, which paths, what an untracked file
/// counts as — is about git's answers, and none of it needs a session.
fn collect_changes(root: &str, writes: &SessionWrites) -> Result<SessionChanges, String> {
    let paths = relative_paths(
        Path::new(root),
        &writes.paths.iter().map(|w| w.path.clone()).collect::<Vec<_>>(),
    );
    let (base, base_label) = baseline(root, writes.first_commit.as_deref())?;

    if paths.is_empty() {
        return Ok(SessionChanges {
            base,
            base_label,
            files: Vec::new(),
            file_count: 0,
            additions: 0,
            deletions: 0,
            unchanged: 0,
            turn_start_ms: writes.last_prompt_ms,
        });
    }

    // One `git diff` for every tracked path at once. The worktree side is
    // implicit — `diff <base>` with no second revision compares the base against
    // what is on disk right now, which is the whole point: a change made a
    // second ago and not yet committed is the change being watched.
    let mut args = vec!["diff", "--numstat", "--no-color", &base, "--"];
    args.extend(paths.iter().map(String::as_str));
    let numstat = git(root, &args)?;

    let touch = |path: &str| -> (u64, u64) {
        writes
            .paths
            .iter()
            .find(|write| write.path.ends_with(path))
            .map(|write| (write.last_ms, write.changes))
            .unwrap_or((0, 0))
    };

    let mut files: Vec<ChangedFile> = numstat
        .lines()
        .filter_map(parse_numstat)
        .map(|(additions, deletions, path)| {
            let (last_touch_ms, touches) = touch(&path);
            ChangedFile { path, additions, deletions, untracked: false, last_touch_ms, touches }
        })
        .collect();

    for path in untracked_among(root, &paths)? {
        let (additions, deletions) = untracked_numstat(root, &path);
        let (last_touch_ms, touches) = touch(&path);
        files.push(ChangedFile {
            path,
            additions,
            deletions,
            untracked: true,
            last_touch_ms,
            touches,
        });
    }

    let additions = files.iter().filter_map(|f| f.additions).map(u64::from).sum();
    let deletions = files.iter().filter_map(|f| f.deletions).map(u64::from).sum();
    // Newest write first: a pane watching a live session wants the file it just
    // touched at the top, and a file git found but the transcript cannot date
    // sorts to the bottom rather than to the top.
    files.sort_by(|a, b| b.last_touch_ms.cmp(&a.last_touch_ms).then_with(|| a.path.cmp(&b.path)));
    let file_count = files.len() as u64;
    let unchanged = (paths.len() as u64).saturating_sub(file_count);
    files.truncate(MAX_FILES);

    Ok(SessionChanges {
        base,
        base_label,
        files,
        file_count,
        additions,
        deletions,
        unchanged,
        turn_start_ms: writes.last_prompt_ms,
    })
}

/// What one session has changed on disk, against where it started.
///
/// `async` for the same reason the recap is: the first fold of a large
/// transcript is measured in seconds, and every `git` here blocks until the
/// child exits.
#[tauri::command(async)]
pub fn session_changes(
    cwd: String,
    file: String,
    cache: State<'_, RecapCache>,
) -> Result<SessionChanges, String> {
    let root = crate::git::git_root(cwd).ok_or_else(|| "not a git repo".to_string())?;
    let writes = session_writes(Path::new(&file), &cache)?;
    collect_changes(&root, &writes)
}

/// One file's patch against the session's baseline.
///
/// Separate from the scan because the scan runs on a timer and a patch does not:
/// a pane refreshing every couple of seconds asks for line counts, and for the
/// bytes of the one file you have open.
#[tauri::command(async)]
pub fn session_change_patch(
    cwd: String,
    base: String,
    path: String,
    untracked: Option<bool>,
) -> Result<String, String> {
    let root = crate::git::git_root(cwd).ok_or_else(|| "not a git repo".to_string())?;
    if untracked.unwrap_or(false) {
        return crate::git::git_patch_out(
            &root,
            &["diff", "--no-color", "--no-index", "--", "/dev/null", &path],
            true,
        );
    }
    crate::git::git_patch_out(&root, &["diff", "--no-color", &base, "--", &path], false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_git_numstat_including_binary_files() {
        assert_eq!(
            parse_numstat("12\t3\tsrc/lib/rail.ts"),
            Some((Some(12), Some(3), "src/lib/rail.ts".to_string()))
        );
        // A binary file counts as neither, and must not read as zero changes.
        assert_eq!(
            parse_numstat("-\t-\ticons/app.png"),
            Some((None, None, "icons/app.png".to_string()))
        );
        // A path with a tab in it keeps it: the split is capped at three fields.
        assert_eq!(
            parse_numstat("1\t0\tweird\tname.ts"),
            Some((Some(1), Some(0), "weird\tname.ts".to_string()))
        );
        assert_eq!(parse_numstat(""), None);
        assert_eq!(parse_numstat("1\t2\t"), None);
    }

    #[test]
    fn narrows_transcript_paths_to_the_repo() {
        let root = PathBuf::from("/home/me/repo");
        let paths = relative_paths(
            &root,
            &[
                "/home/me/repo/src/x.ts".to_string(),
                // A session started in a subdirectory still records absolutes.
                "/home/me/repo/packages/web/src/y.ts".to_string(),
                // Outside the repo: a scratch file, or another repo entirely.
                "/tmp/scratch.ts".to_string(),
                "/home/me/other/z.ts".to_string(),
                // The same file written twice is one path to diff.
                "/home/me/repo/src/x.ts".to_string(),
            ],
        );
        assert_eq!(paths, vec!["packages/web/src/y.ts", "src/x.ts"]);
    }

    /// Per-test scratch repo, removed and recreated so a rerun starts clean.
    fn repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mangouste-changes-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        run(&dir, &["init", "--quiet", "--initial-branch=main", "."]);
        dir
    }

    fn run(cwd: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
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
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn write(dir: &Path, path: &str, text: &str) {
        let full = dir.join(path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(full, text).expect("write");
    }

    /// A write-set as the transcript fold would hand one over: absolute paths.
    fn wrote(dir: &Path, paths: &[&str], first_commit: Option<&str>) -> SessionWrites {
        SessionWrites {
            paths: paths
                .iter()
                .map(|path| crate::recap::SessionWrite {
                    path: dir.join(path).to_string_lossy().into_owned(),
                    changes: 1,
                    last_ms: 1_000,
                })
                .collect(),
            first_commit: first_commit.map(str::to_string),
            last_prompt_ms: 900,
        }
    }

    #[test]
    fn counts_uncommitted_work_against_head() {
        let dir = repo("dirty");
        write(&dir, "src/a.ts", "one\ntwo\n");
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "--quiet", "-m", "base"]);
        let head = run(&dir, &["rev-parse", "HEAD"]).trim().to_string();

        // What the session did: one line added to a tracked file, and one file
        // created that git has never seen.
        write(&dir, "src/a.ts", "one\ntwo\nthree\n");
        write(&dir, "src/new.ts", "fresh\n");

        let root = dir.to_string_lossy().into_owned();
        let changes =
            collect_changes(&root, &wrote(&dir, &["src/a.ts", "src/new.ts"], None)).expect("scan");

        assert_eq!(changes.base, head);
        assert_eq!(changes.base_label, "HEAD");
        assert_eq!(changes.additions, 2);
        assert_eq!(changes.deletions, 0);
        let new_file = changes.files.iter().find(|f| f.path == "src/new.ts").expect("the new file");
        // An untracked file has no tracked side, so `git diff` alone would have
        // said nothing at all about the one file where every line is new.
        assert!(new_file.untracked);
        assert_eq!(new_file.additions, Some(1));
    }

    #[test]
    fn keeps_work_the_session_has_already_committed() {
        let dir = repo("committed");
        write(&dir, "a.ts", "one\n");
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "--quiet", "-m", "before the session"]);

        // The session's own commit, plus an edit it has not committed yet.
        write(&dir, "a.ts", "one\ntwo\n");
        run(&dir, &["commit", "--quiet", "-am", "the session's commit"]);
        let session_sha = run(&dir, &["rev-parse", "--short", "HEAD"]).trim().to_string();
        write(&dir, "a.ts", "one\ntwo\nthree\n");

        let root = dir.to_string_lossy().into_owned();
        let changes = collect_changes(&root, &wrote(&dir, &["a.ts"], Some(&session_sha)))
            .expect("scan");

        // Diffing against HEAD would have shown one line: the uncommitted one.
        // The session added two, and the second is only visible from before its
        // own commit.
        assert_eq!(changes.base_label, format!("before {session_sha}"));
        assert_eq!(changes.additions, 2);
    }

    #[test]
    fn a_file_written_back_to_what_it_said_counts_as_unchanged() {
        let dir = repo("reverted");
        write(&dir, "a.ts", "one\n");
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "--quiet", "-m", "base"]);
        // Edited and undone: the transcript remembers both writes, git has
        // nothing to show, and the pane says so rather than listing a row with
        // no lines in it.
        write(&dir, "a.ts", "one\n");

        let root = dir.to_string_lossy().into_owned();
        let changes = collect_changes(&root, &wrote(&dir, &["a.ts"], None)).expect("scan");
        assert_eq!(changes.file_count, 0);
        assert_eq!(changes.unchanged, 1);
    }

    #[test]
    fn a_sha_git_no_longer_knows_falls_back_to_head() {
        let dir = repo("rebased");
        write(&dir, "a.ts", "one\n");
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "--quiet", "-m", "base"]);
        write(&dir, "a.ts", "one\ntwo\n");

        // The sha the session's `git commit` printed, since amended away.
        let root = dir.to_string_lossy().into_owned();
        let changes = collect_changes(&root, &wrote(&dir, &["a.ts"], Some("deadbee")))
            .expect("scan");
        assert_eq!(changes.base_label, "HEAD");
        assert_eq!(changes.additions, 1);
    }

    #[test]
    fn ignores_files_the_session_never_wrote() {
        let dir = repo("narrow");
        write(&dir, "mine.ts", "one\n");
        write(&dir, "theirs.ts", "one\n");
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "--quiet", "-m", "base"]);
        // Two sessions in one repo: the pile is shared, the answer is not.
        write(&dir, "mine.ts", "one\ntwo\n");
        write(&dir, "theirs.ts", "one\nsomeone else\n");

        let root = dir.to_string_lossy().into_owned();
        let changes = collect_changes(&root, &wrote(&dir, &["mine.ts"], None)).expect("scan");
        assert_eq!(changes.files.len(), 1);
        assert_eq!(changes.files[0].path, "mine.ts");
    }

    #[test]
    fn shortens_a_sha_for_the_baseline_label() {
        assert_eq!(short("15fd105aa9b3c4d5e6f7"), "15fd105");
        assert_eq!(short("abc"), "abc");
    }
}
