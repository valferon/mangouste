//! What a session actually did, mined from its own transcript.
//!
//! The sidebar can already say that a session exists, what it was called, and
//! whether anything is running in it. None of that answers the question you have
//! three days later — "what did I *do* in there" — and the only honest answer is
//! in the tool calls: the files it wrote, the commits it landed, the branches it
//! was on, what it fanned out to. A title is a guess at the intent; this is the
//! record of the work.
//!
//! Nothing here is part of the sidebar scan, and that is deliberate. This is the
//! one reader in the app that walks a whole transcript, and it gets away with it
//! three ways: nothing asks for a recap until a row is expanded, the walk resumes
//! from a byte offset so a live session re-folds only what it appended, and the
//! substring gate in `fold_line` refuses to parse the lines that cannot carry an
//! answer — which is most of them by weight. Cold, the whole 389-transcript
//! corpus on this machine folds in 1.2s, the largest single file (27MB) in 45ms.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::sessions::{is_interrupt_marker, is_synthetic_echo, str_field, text_payloads};
use crate::stats::NameCount;

/// Tools whose call means a file on disk changed. `MultiEdit` and `NotebookEdit`
/// are counted as one change per call rather than per edit inside it: the row
/// says how many times you came back to a file, and a batched edit is one visit.
const WRITE_TOOLS: [&str; 4] = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

/// Tools that spawn a subagent. `Task` is the old name for `Agent`; transcripts
/// on disk predate the rename.
const AGENT_TOOLS: [&str; 2] = ["Agent", "Task"];

/// Rows listed per section. Everything is counted in full — the caps only decide
/// what is shown, and the totals beside them say what was left out.
const RECAP_FILES: usize = 12;
const RECAP_COMMITS: usize = 12;
const RECAP_TOOLS: usize = 8;
const RECAP_AGENTS: usize = 8;

/// Characters kept of a prompt. Long enough to recognise what you asked for,
/// short enough that it is a label rather than a transcript.
const RECAP_PROMPT_CHARS: usize = 240;

/// Bytes folded per transcript, ever. A recap of the first 64MB of a session is
/// worth having; an unbounded read on a runaway log file is not.
const RECAP_CAP_BYTES: u64 = 64 * 1024 * 1024;

/// Lines this long are folded for their tool calls but never for a commit line:
/// a record this big is a payload (a pasted file, a whole build log), and the
/// eight-line commit scan below would be walking bytes to no purpose.
const RECAP_COMMIT_SCAN_LINE_CAP: usize = 256 * 1024;

/// Lines of a tool result searched for git's commit announcement. `git commit`
/// prints it first, before the file-count summary.
const COMMIT_SCAN_LINES: usize = 8;

/* ---------- what comes back ---------- */

/// One file the session changed, and how often.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecapFile {
    pub path: String,
    pub changes: u64,
    /// A `Write` landed on it, so the session may have created it outright.
    /// Not a claim that it did — `Write` overwrites an existing file too.
    pub written: bool,
}

/// One commit the session landed, as git's own output announced it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecapCommit {
    pub sha: String,
    /// Whatever git printed in the brackets: a branch name, or `detached HEAD`.
    pub branch: String,
    pub subject: String,
}

/// One kind of subagent the session spawned, with the last thing it was asked.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecapAgent {
    pub agent_type: String,
    pub description: String,
    pub count: u64,
}

/// Everything the recap panel shows for one session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecap {
    pub file: String,
    /// The first thing you asked, which is the closest thing a transcript has to
    /// a statement of intent.
    pub first_prompt: Option<String>,
    /// The last thing you asked, which is where you left off.
    pub last_prompt: Option<String>,
    pub prompts: u64,
    pub files: Vec<RecapFile>,
    /// Distinct files changed, before the display cap.
    pub file_count: u64,
    /// Newest last, and the tail of the list when there were more than the cap.
    pub commits: Vec<RecapCommit>,
    pub commit_count: u64,
    /// Branches the session ran on, in the order it first saw them.
    pub branches: Vec<String>,
    pub tools: Vec<NameCount>,
    pub tool_calls: u64,
    pub agents: Vec<RecapAgent>,
    /// Subagent calls in total, which is more than `agents.len()`.
    pub agent_count: u64,
    /// Bytes folded on this call. Zero means the answer came from the cache
    /// unchanged, which is what makes re-expanding a row free.
    pub bytes_read: u64,
    pub scan_ms: u64,
    /// The transcript is longer than `RECAP_CAP_BYTES`, so this is a prefix.
    pub truncated: bool,
}

/* ---------- the fold ---------- */

/// One file's running tally.
#[derive(Debug, Clone, Default)]
struct FileTouch {
    changes: u64,
    written: bool,
}

/// One agent type's running tally.
#[derive(Debug, Clone, Default)]
struct AgentTouch {
    agent_type: String,
    description: String,
    count: u64,
}

/// Everything one transcript contributes, accumulated across incremental reads.
#[derive(Debug, Clone, Default)]
struct RecapAcc {
    first_prompt: Option<String>,
    last_prompt: Option<String>,
    prompts: u64,
    files: BTreeMap<String, FileTouch>,
    commits: Vec<RecapCommit>,
    /// Shas already listed. A `git commit` announcement is echoed back by any
    /// later `git log` the session ran, and one commit is one row.
    seen_commits: HashSet<String>,
    /// First-seen order, which is chronological — a session that switched
    /// branches did so in this order.
    branches: Vec<String>,
    tools: BTreeMap<String, u64>,
    tool_calls: u64,
    agents: BTreeMap<String, AgentTouch>,
    agent_count: u64,
}

/// One transcript's resume point.
struct RecapScan {
    /// Bytes already folded in as whole lines.
    offset: u64,
    acc: RecapAcc,
    /// The walk stopped at `RECAP_CAP_BYTES` with the file still going.
    truncated: bool,
}

impl Default for RecapScan {
    fn default() -> Self {
        Self { offset: 0, acc: RecapAcc::default(), truncated: false }
    }
}

/// Per-transcript scan state.
///
/// Two locks rather than one: the outer map is held only long enough to hand out
/// a transcript's own lock, so a cold 27MB walk blocks a second recap of the
/// *same* session — which is the point, it would otherwise redo the whole walk —
/// and never one of a different session.
#[derive(Default)]
pub struct RecapCache {
    files: Mutex<HashMap<PathBuf, Arc<Mutex<RecapScan>>>>,
}

/// The value of a top-level JSON string field, without parsing the record.
///
/// Every record carries `gitBranch`, so parsing each one to read it would mean
/// parsing the whole transcript — the cost the gate in `fold_line` exists to
/// avoid. Escapes are not decoded: a branch name containing a quote is rarer
/// than this function is hot, and the worst case is one odd-looking row.
fn raw_string_field<'line>(line: &'line str, key_pattern: &str) -> Option<&'line str> {
    let at = line.find(key_pattern)? + key_pattern.len();
    let rest = line.get(at..)?;
    let end = rest.find('"')?;
    rest.get(..end)
}

const GIT_BRANCH_PATTERN: &str = r#""gitBranch":""#;

/// A commit git just made, parsed from the line git printed about it.
///
/// `[main 15fd105] subject`, `[develop 6e6e481] subject`,
/// `[detached HEAD e40f553] subject`, `[main (root-commit) abc1234] subject`.
///
/// Read from the tool *result* rather than from the `git commit` command that
/// caused it, which is the difference between "a commit was attempted" and "a
/// commit exists": the command may have died in a pre-commit hook, and its `-m`
/// argument is routinely a heredoc that reading would mean re-implementing a
/// shell. The sha is the proof, and it only exists once the commit does.
fn commit_from_line(line: &str) -> Option<RecapCommit> {
    let rest = line.trim().strip_prefix('[')?;
    let close = rest.find("] ")?;
    let inside = rest.get(..close)?;
    let subject = rest.get(close + 2..)?.trim();
    if subject.is_empty() || inside.contains('[') {
        return None;
    }
    let (branch, sha) = inside.rsplit_once(' ')?;
    // The shape of an abbreviated sha, which is what keeps `[note 1] see below`
    // out of the commit list.
    if !(7..=40).contains(&sha.len()) || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    if branch.is_empty() {
        return None;
    }
    Some(RecapCommit {
        sha: sha.to_string(),
        branch: branch.to_string(),
        subject: subject.chars().take(RECAP_PROMPT_CHARS).collect(),
    })
}

/// Collapse whitespace and cut to a label's length.
fn flatten(text: &str, chars: usize) -> Option<String> {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        None
    } else {
        Some(flat.chars().take(chars).collect())
    }
}

/// The path a write-tool call names. `NotebookEdit` calls it something else.
fn written_path(input: &Value) -> Option<String> {
    for key in ["file_path", "notebook_path", "path"] {
        if let Some(path) = input.get(key).and_then(Value::as_str) {
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    None
}

/// Every text payload of a tool result, whichever shape this CLI version wrote.
///
/// Both shapes are checked rather than one: `content` is a bare string in the
/// overwhelming majority of records and a block array in the rest, and the
/// commit announcement is equally likely to be in either.
fn tool_result_texts(block: &Value) -> Vec<&str> {
    match block.get("content") {
        Some(Value::String(text)) => vec![text.as_str()],
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|inner| inner.get("text").and_then(Value::as_str))
            .collect(),
        _ => Vec::new(),
    }
}

/// Scan the head of a tool result for a commit git announced in it.
fn note_commits(text: &str, acc: &mut RecapAcc) {
    if text.len() > RECAP_COMMIT_SCAN_LINE_CAP {
        return;
    }
    for line in text.lines().take(COMMIT_SCAN_LINES) {
        let Some(commit) = commit_from_line(line) else { continue };
        if acc.seen_commits.insert(commit.sha.clone()) {
            acc.commits.push(commit);
        }
    }
}

/// Fold one transcript line into the accumulator.
///
/// The substring gate is the whole performance story. A transcript is mostly
/// assistant prose, thinking blocks and attachments, none of which say anything
/// about what was *done*; only records carrying a tool call, a tool result or a
/// human turn are worth a parse, and those are a minority of lines by weight.
fn fold_line(line: &str, acc: &mut RecapAcc) {
    // Read before the gate: it costs a substring scan, and it is the one fact
    // every record carries and no parse is worth paying for.
    if let Some(branch) = raw_string_field(line, GIT_BRANCH_PATTERN) {
        if !branch.is_empty() && !acc.branches.iter().any(|seen| seen == branch) {
            acc.branches.push(branch.to_string());
        }
    }

    let interesting = line.contains(r#""tool_use""#)
        || line.contains(r#""tool_result""#)
        || line.contains(r#""type":"user""#);
    if !interesting {
        return;
    }
    let Ok(record) = serde_json::from_str::<Value>(line) else { return };
    // A sidechain record in a parent transcript would credit the parent with an
    // agent's work twice — once here, once in the agent's own recap.
    if record.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return;
    }
    let Some(message) = record.get("message") else { return };
    let record_type = str_field(&record, "type").unwrap_or_default();

    if record_type == "assistant" {
        let Some(blocks) = message.get("content").and_then(Value::as_array) else { return };
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let name = block.get("name").and_then(Value::as_str).unwrap_or("unknown");
            *acc.tools.entry(name.to_string()).or_insert(0) += 1;
            acc.tool_calls += 1;
            let input = block.get("input").unwrap_or(&Value::Null);

            if WRITE_TOOLS.contains(&name) {
                if let Some(path) = written_path(input) {
                    let touch = acc.files.entry(path).or_default();
                    touch.changes += 1;
                    touch.written |= name == "Write";
                }
            }
            if AGENT_TOOLS.contains(&name) {
                acc.agent_count += 1;
                let agent_type = input
                    .get("subagent_type")
                    .and_then(Value::as_str)
                    .unwrap_or("general-purpose")
                    .to_string();
                let description = input
                    .get("description")
                    .and_then(Value::as_str)
                    .and_then(|text| flatten(text, RECAP_PROMPT_CHARS))
                    .unwrap_or_default();
                let touch = acc.agents.entry(agent_type.clone()).or_default();
                touch.agent_type = agent_type;
                touch.count += 1;
                // Last one wins: the newest fan-out is the one you are trying to
                // remember, and an older description is a row already counted.
                if !description.is_empty() {
                    touch.description = description;
                }
            }
        }
        return;
    }

    if record_type != "user" {
        return;
    }

    // A user record is either a real turn or the harness echoing a tool back.
    let blocks = message.get("content").and_then(Value::as_array);
    let mut had_result = false;
    if let Some(blocks) = blocks {
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            had_result = true;
            for text in tool_result_texts(block) {
                note_commits(text, acc);
            }
        }
    }
    // Some CLI versions also park the structured result at the top level, and a
    // `git commit` whose output only landed there is still a commit.
    if let Some(stdout) = record
        .get("toolUseResult")
        .and_then(|result| result.get("stdout"))
        .and_then(Value::as_str)
    {
        had_result = true;
        note_commits(stdout, acc);
    }
    if had_result {
        return;
    }
    if is_synthetic_echo(message) || is_interrupt_marker(message) {
        return;
    }
    let Some(prompt) = flatten(&text_payloads(message).join(" "), RECAP_PROMPT_CHARS) else {
        return;
    };
    acc.prompts += 1;
    if acc.first_prompt.is_none() {
        acc.first_prompt = Some(prompt.clone());
    }
    acc.last_prompt = Some(prompt);
}

/// Fold whatever has been appended since the last call. Returns bytes folded.
fn scan_file(path: &Path, scan: &mut RecapScan) -> std::io::Result<u64> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    // A transcript that shrank is not the transcript that was scanned — a resume
    // can rewrite one wholesale — and folding new bytes into an accumulator
    // built from the old file would report two sessions' work as one.
    if size < scan.offset {
        *scan = RecapScan::default();
    }
    if scan.offset >= size {
        return Ok(0);
    }
    if scan.offset >= RECAP_CAP_BYTES {
        scan.truncated = true;
        return Ok(0);
    }

    file.seek(SeekFrom::Start(scan.offset))?;
    let mut reader = BufReader::new(file);
    let mut line: Vec<u8> = Vec::new();
    let mut folded = 0u64;

    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        // A line with no newline on it is one a live session is still writing.
        // Leaving the offset before it is what makes the next call fold it whole
        // instead of folding half a record now and the other half later.
        if line.last() != Some(&b'\n') {
            break;
        }
        scan.offset += read as u64;
        folded += read as u64;
        fold_line(&String::from_utf8_lossy(&line), &mut scan.acc);
        if scan.offset >= RECAP_CAP_BYTES {
            scan.truncated = true;
            break;
        }
    }
    Ok(folded)
}

/// Shape the accumulator into what the panel renders.
fn present(file: String, scan: &RecapScan, bytes_read: u64, scan_ms: u64) -> SessionRecap {
    let acc = &scan.acc;

    let mut files: Vec<RecapFile> = acc
        .files
        .iter()
        .map(|(path, touch)| RecapFile {
            path: path.clone(),
            changes: touch.changes,
            written: touch.written,
        })
        .collect();
    // Most-changed first: the file you went back to eleven times is what the
    // session was about, and the one you touched once is a detail.
    files.sort_by(|a, b| b.changes.cmp(&a.changes).then_with(|| a.path.cmp(&b.path)));
    let file_count = files.len() as u64;
    files.truncate(RECAP_FILES);

    let commit_count = acc.commits.len() as u64;
    // The tail, not the head: when a session made more commits than fit, the
    // recent ones are the ones you are trying to remember.
    let commits = acc
        .commits
        .iter()
        .skip(acc.commits.len().saturating_sub(RECAP_COMMITS))
        .cloned()
        .collect();

    let mut tools: Vec<NameCount> = acc
        .tools
        .iter()
        .map(|(name, count)| NameCount { name: name.clone(), count: *count })
        .collect();
    tools.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
    tools.truncate(RECAP_TOOLS);

    let mut agents: Vec<RecapAgent> = acc
        .agents
        .values()
        .map(|touch| RecapAgent {
            agent_type: touch.agent_type.clone(),
            description: touch.description.clone(),
            count: touch.count,
        })
        .collect();
    agents.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.agent_type.cmp(&b.agent_type)));
    agents.truncate(RECAP_AGENTS);

    SessionRecap {
        file,
        first_prompt: acc.first_prompt.clone(),
        last_prompt: acc.last_prompt.clone(),
        prompts: acc.prompts,
        files,
        file_count,
        commits,
        commit_count,
        branches: acc.branches.clone(),
        tools,
        tool_calls: acc.tool_calls,
        agents,
        agent_count: acc.agent_count,
        bytes_read,
        scan_ms,
        truncated: scan.truncated,
    }
}

/// What one session did, from its transcript.
///
/// `async` so the walk runs on the blocking pool rather than inline on the GTK
/// main loop: the first call on a large transcript is the one read in this app
/// that is measured in seconds, and it must not be the one that freezes the
/// window.
#[tauri::command(async)]
pub fn session_recap(file: String, cache: State<'_, RecapCache>) -> Result<SessionRecap, String> {
    let path = PathBuf::from(&file);
    let started = Instant::now();
    // Outer lock held only to hand out this transcript's own lock; see the
    // comment on `RecapCache`.
    let entry = cache.files.lock().entry(path.clone()).or_default().clone();
    let mut scan = entry.lock();
    let bytes_read = scan_file(&path, &mut scan).map_err(|e| e.to_string())?;
    Ok(present(file, &scan, bytes_read, started.elapsed().as_millis() as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recap_of(lines: &[&str]) -> SessionRecap {
        let mut scan = RecapScan::default();
        for line in lines {
            fold_line(line, &mut scan.acc);
        }
        present("t.jsonl".into(), &scan, 0, 0)
    }

    #[test]
    fn reads_a_commit_out_of_what_git_printed() {
        let commit = commit_from_line("[main 15fd105] chore: release v0.1.15").expect("a commit");
        assert_eq!(commit.sha, "15fd105");
        assert_eq!(commit.branch, "main");
        assert_eq!(commit.subject, "chore: release v0.1.15");

        // A detached head and a root commit both put a space inside the brackets.
        assert_eq!(
            commit_from_line("[detached HEAD e40f553] fix: a thing").expect("a commit").branch,
            "detached HEAD"
        );
        assert_eq!(
            commit_from_line("[main (root-commit) abc1234] first").expect("a commit").branch,
            "main (root-commit)"
        );
        // Leading whitespace is git's own, on the summary line below the first.
        assert!(commit_from_line("   [main 15fd105] indented").is_some());
    }

    #[test]
    fn refuses_things_that_merely_look_like_one() {
        // A markdown reference, a short hex word, a bracketed note: none of these
        // are commits, and every one of them would be a lie in the recap.
        for line in [
            "[note 1] see below",
            "[main abc123] six chars is not a sha",
            "[main notahex] not hex",
            "[main 15fd105]",
            "[15fd105] no branch",
            "[[main 15fd105]] nested",
            "1 file changed, 4 insertions(+)",
        ] {
            assert!(commit_from_line(line).is_none(), "{line} parsed as a commit");
        }
    }

    #[test]
    fn counts_the_work_and_not_the_talk() {
        let recap = recap_of(&[
            r#"{"type":"user","gitBranch":"main","message":{"role":"user","content":[{"type":"text","text":"  make   the rail sortable "}]}}"#,
            // Thinking and prose say nothing about what was done.
            r#"{"type":"assistant","gitBranch":"main","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"on it"}]}}"#,
            r#"{"type":"assistant","gitBranch":"main","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/src/rail.tsx"}}]}}"#,
            r#"{"type":"assistant","gitBranch":"main","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/src/rail.tsx"}}]}}"#,
            r#"{"type":"assistant","gitBranch":"main","message":{"role":"assistant","content":[{"type":"tool_use","name":"Write","input":{"file_path":"/repo/src/sort.ts"}}]}}"#,
            r#"{"type":"assistant","gitBranch":"main","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"git commit -m x"}}]}}"#,
            r#"{"type":"user","gitBranch":"main","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"[main 9f3c1aa] feat: a sortable rail\n 2 files changed"}]}}"#,
            // The same commit echoed back by a later `git log` is one commit.
            r#"{"type":"user","gitBranch":"release","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"[main 9f3c1aa] feat: a sortable rail"}]}}"#,
            // A slash-command echo is not a prompt.
            r#"{"type":"user","gitBranch":"release","message":{"role":"user","content":[{"type":"text","text":"<command-name>/model</command-name></command-name>"}]}}"#,
            r#"{"type":"user","gitBranch":"release","message":{"role":"user","content":[{"type":"text","text":"now ship it"}]}}"#,
        ]);

        assert_eq!(recap.prompts, 2);
        assert_eq!(recap.first_prompt.as_deref(), Some("make the rail sortable"));
        assert_eq!(recap.last_prompt.as_deref(), Some("now ship it"));

        assert_eq!(recap.file_count, 2);
        assert_eq!(recap.files[0].path, "/repo/src/rail.tsx");
        assert_eq!(recap.files[0].changes, 2, "most-changed file leads");
        assert!(!recap.files[0].written);
        assert!(recap.files[1].written, "a Write may have created it");

        assert_eq!(recap.commit_count, 1);
        assert_eq!(recap.commits[0].subject, "feat: a sortable rail");
        assert_eq!(recap.branches, vec!["main", "release"], "in the order it saw them");
        assert_eq!(recap.tool_calls, 4);
        assert_eq!(recap.tools[0].name, "Edit");
        assert_eq!(recap.tools[0].count, 2);
    }

    #[test]
    fn credits_an_agents_work_to_the_agent() {
        let recap = recap_of(&[
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Agent","input":{"subagent_type":"Explore","description":"find the rail"}}]}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Agent","input":{"subagent_type":"Explore","description":"find the sort"}}]}}"#,
            // The agent's own edits are written to its sidechain, which the
            // parent must not also claim.
            r#"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/src/agent-only.ts"}}]}}"#,
        ]);
        assert_eq!(recap.agent_count, 2);
        assert_eq!(recap.agents.len(), 1, "one type, twice");
        assert_eq!(recap.agents[0].description, "find the sort", "the newest ask");
        assert_eq!(recap.file_count, 0, "the sidechain edit belongs to the agent");
    }

    #[test]
    fn resumes_where_the_last_read_stopped() {
        let dir = std::env::temp_dir().join("mangouste-recap-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("resume.jsonl");
        let first = concat!(
            r#"{"type":"user","gitBranch":"main","message":{"role":"user","content":"one"}}"#,
            "\n"
        );
        std::fs::write(&path, first).expect("write");

        let mut scan = RecapScan::default();
        let read = scan_file(&path, &mut scan).expect("a scan");
        assert_eq!(read as usize, first.len());
        assert_eq!(scan.acc.prompts, 1);

        // A partial line is not folded, and the offset stays before it — so the
        // record is counted once, when the rest of it arrives.
        let partial = r#"{"type":"user","gitBranch":"main","message":{"role":"user","cont"#;
        std::fs::write(&path, format!("{first}{partial}")).expect("append");
        assert_eq!(scan_file(&path, &mut scan).expect("a scan"), 0);
        assert_eq!(scan.acc.prompts, 1);

        let rest = "ent\":\"two\"}}\n";
        std::fs::write(&path, format!("{first}{partial}{rest}")).expect("finish the line");
        assert_eq!(scan_file(&path, &mut scan).expect("a scan") as usize, partial.len() + rest.len());
        assert_eq!(scan.acc.prompts, 2);
        assert_eq!(scan.acc.last_prompt.as_deref(), Some("two"));

        // A transcript that shrank is a different transcript.
        std::fs::write(&path, first).expect("rewrite shorter");
        scan_file(&path, &mut scan).expect("a scan");
        assert_eq!(scan.acc.prompts, 1, "the accumulator was rebuilt, not appended to");

        std::fs::remove_file(&path).ok();
    }

    /// Recaps every transcript on the machine. Ignored by default — it is a
    /// benchmark: `cargo test recaps_local_corpus -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn recaps_local_corpus() {
        let Some(root) = crate::sessions::projects_root() else { return };
        let mut worst = (0u64, PathBuf::new());
        let mut total = 0u64;
        let mut files = 0u64;
        for dir in std::fs::read_dir(&root).into_iter().flatten().flatten() {
            for file in std::fs::read_dir(dir.path()).into_iter().flatten().flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let started = Instant::now();
                let mut scan = RecapScan::default();
                if scan_file(&path, &mut scan).is_err() {
                    continue;
                }
                let ms = started.elapsed().as_millis() as u64;
                files += 1;
                total += ms;
                if ms > worst.0 {
                    worst = (ms, path.clone());
                }
                let recap = present(String::new(), &scan, 0, ms);
                if recap.commit_count > 0 || recap.file_count > 0 {
                    eprintln!(
                        "{:>6}ms {:>3} files {:>2} commits  {}",
                        ms,
                        recap.file_count,
                        recap.commit_count,
                        path.file_stem().unwrap_or_default().to_string_lossy()
                    );
                }
            }
        }
        eprintln!("{files} transcripts, {total}ms total, worst {}ms {:?}", worst.0, worst.1);
    }
}
