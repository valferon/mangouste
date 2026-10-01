//! Whether a session is over, or only stopped.
//!
//! The status column answers a question about the last *turn*: `finished`
//! means it ended cleanly, not that the work did. Prototype of the session-level
//! answer — errand or project, done or parked — read off the whole transcript
//! and, where the transcript cannot tell, off the repo it ran in.
//!
//! Two things the corpus on this machine forced. No session ever called
//! `TodoWrite`, so there is no plan to read and progress has to be inferred from
//! outcomes. And most file changes go through `Bash` (`sed -i`, heredocs), so the
//! write-tool path list is a floor, and "is anything left uncommitted" has to be
//! asked of git rather than of the transcript.
//!
//! Nothing here calls a model. `Unclear` is the slot a cheap classifier would
//! fill; everything else is decided by evidence you can point at.

use std::collections::BTreeSet;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::Command;

use serde::Serialize;
use serde_json::Value;

use crate::sessions::{is_interrupt_marker, is_synthetic_echo, str_field, text_payloads};

/// Tools whose call means a file on disk changed.
const WRITE_TOOLS: [&str; 4] = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

/// Tools that leave the result somewhere other people see it. A session that
/// called one of these handed its work over, which is the non-code version of a
/// push. Matched as a suffix so the MCP server prefix does not matter.
const DELIVERY_TOOLS: [&str; 12] = [
    "slack_send_message",
    "slack_schedule_message",
    "addCommentToJiraIssue",
    "createJiraIssue",
    "editJiraIssue",
    "transitionJiraIssue",
    "createConfluencePage",
    "updateConfluencePage",
    "kb_write",
    "kb_submit",
    "mark_done",
    "report_patch",
];

/// Tools that end a turn blocked on you.
const INPUT_TOOLS: [&str; 2] = ["AskUserQuestion", "ExitPlanMode"];

/// Branches that are the trunk rather than a line of work.
const TRUNK_BRANCHES: [&str; 5] = ["main", "master", "develop", "trunk", "HEAD"];

/// Quiet for less than this and the session is still yours to answer, not a
/// verdict to reach: every turn ends looking unfinished while you are typing.
pub const WALK_AWAY_MS: u64 = 60 * 60_000;

/// A project by size alone. Past this many prompts it was not a quick ask.
const PROJECT_PROMPTS: u64 = 6;

/// How much of the last assistant text is kept and searched for an offer.
const TAIL_CHARS: usize = 400;

/// Phrases that end a reply with work still on the table.
const OFFER_PHRASES: [&str; 10] = [
    "want me to",
    "should i ",
    "shall i ",
    "would you like",
    "let me know",
    "do you want",
    "next step",
    "if you want",
    "i can also",
    "ready to",
];

/// Short last prompts that close a conversation rather than continue it.
const WRAP_UPS: [&str; 12] = [
    "thanks",
    "thank you",
    "thx",
    "merged",
    "done",
    "lgtm",
    "perfect",
    "great",
    "cool",
    "nice",
    "ok",
    "shipped",
];

/* ---------- what the transcript says ---------- */

/// Everything one transcript says about whether its work is over.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub title: Option<String>,
    /// The title is a rename, which outranks every generated one.
    #[serde(skip)]
    title_custom: bool,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub prompts: u64,
    pub first_prompt: Option<String>,
    pub last_prompt: Option<String>,
    pub first_ms: u64,
    pub last_ms: u64,
    /// Distinct UTC days with a real prompt on them.
    pub days: BTreeSet<String>,
    /// Paths named by write-tool calls. A floor: Bash writes are invisible.
    pub written: BTreeSet<String>,
    pub bash_calls: u64,
    pub commits: u64,
    pub pushed: bool,
    pub pr_opened: bool,
    pub pr_merged: bool,
    /// Suffixes of `DELIVERY_TOOLS` the session called, deduplicated.
    pub delivered: BTreeSet<String>,
    /// The newest assistant turn ended on `AskUserQuestion` / `ExitPlanMode`.
    pub awaiting: bool,
    /// The newest user record is the ESC marker.
    pub interrupted: bool,
    pub last_assistant: Option<String>,
    /// Which conversational side spoke last.
    pub last_role: Option<String>,
}

fn flatten(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn tail_chars(text: &str, chars: usize) -> String {
    let count = text.chars().count();
    text.chars().skip(count.saturating_sub(chars)).collect()
}

fn day_of(timestamp: &str) -> Option<String> {
    timestamp.get(..10).map(str::to_string)
}

fn note_bash(command: &str, facts: &mut Facts) {
    facts.bash_calls += 1;
    if command.contains("git push") {
        facts.pushed = true;
    }
    if command.contains("gh pr create") {
        facts.pr_opened = true;
    }
    if command.contains("gh pr merge") {
        facts.pr_merged = true;
    }
}

fn note_assistant(message: &Value, facts: &mut Facts) {
    let Some(blocks) = message.get("content").and_then(Value::as_array) else {
        return;
    };
    let mut awaiting = false;
    let mut text = String::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(chunk) = block.get("text").and_then(Value::as_str) {
                    text.push_str(chunk);
                    text.push(' ');
                }
            }
            Some("tool_use") => {
                let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                let input = block.get("input").unwrap_or(&Value::Null);
                awaiting |= INPUT_TOOLS.contains(&name);
                if WRITE_TOOLS.contains(&name) {
                    if let Some(path) = ["file_path", "notebook_path"]
                        .iter()
                        .find_map(|key| input.get(*key).and_then(Value::as_str))
                    {
                        facts.written.insert(path.to_string());
                    }
                }
                if name == "Bash" {
                    if let Some(command) = input.get("command").and_then(Value::as_str) {
                        note_bash(command, facts);
                    }
                }
                if let Some(hit) = DELIVERY_TOOLS.iter().find(|tool| name.ends_with(*tool)) {
                    facts.delivered.insert((*hit).to_string());
                }
            }
            _ => {}
        }
    }
    facts.awaiting = awaiting;
    facts.last_role = Some("assistant".to_string());
    let text = flatten(&text);
    if !text.is_empty() {
        facts.last_assistant = Some(tail_chars(&text, TAIL_CHARS));
    }
}

/// True for the harness echoing a tool back rather than a person typing.
fn is_tool_result(message: &Value) -> bool {
    message
        .get("content")
        .and_then(Value::as_array)
        .is_some_and(|blocks| {
            blocks
                .iter()
                .any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
        })
}

fn note_commits(record: &Value, message: &Value, facts: &mut Facts) {
    let mut texts: Vec<&str> = Vec::new();
    if let Some(blocks) = message.get("content").and_then(Value::as_array) {
        for block in blocks {
            match block.get("content") {
                Some(Value::String(text)) => texts.push(text),
                Some(Value::Array(inner)) => texts.extend(
                    inner
                        .iter()
                        .filter_map(|b| b.get("text").and_then(Value::as_str)),
                ),
                _ => {}
            }
        }
    }
    if let Some(stdout) = record
        .get("toolUseResult")
        .and_then(|r| r.get("stdout"))
        .and_then(Value::as_str)
    {
        texts.push(stdout);
    }
    // Once per result: the same announcement lands in both shapes.
    if texts.iter().any(|text| {
        text.lines()
            .take(8)
            .any(|line| crate::recap::commit_from_line(line).is_some())
    }) {
        facts.commits += 1;
    }
}

fn note_user(record: &Value, message: &Value, facts: &mut Facts) {
    if is_tool_result(message) {
        note_commits(record, message, facts);
        return;
    }
    if is_synthetic_echo(message) {
        return;
    }
    facts.last_role = Some("user".to_string());
    facts.awaiting = false;
    facts.interrupted = is_interrupt_marker(message);
    if facts.interrupted {
        return;
    }
    let prompt = flatten(&text_payloads(message).join(" "));
    if prompt.is_empty() {
        return;
    }
    facts.prompts += 1;
    if facts.first_prompt.is_none() {
        facts.first_prompt = Some(prompt.chars().take(TAIL_CHARS).collect());
    }
    facts.last_prompt = Some(prompt.chars().take(TAIL_CHARS).collect());
    if let Some(timestamp) = str_field(record, "timestamp") {
        let ms = crate::stats::parse_iso_ms(&timestamp);
        if facts.first_ms == 0 {
            facts.first_ms = ms;
        }
        if let Some(day) = day_of(&timestamp) {
            facts.days.insert(day);
        }
    }
}

/// Fold one transcript line into the facts.
pub fn fold_line(line: &str, facts: &mut Facts) {
    let Ok(record) = serde_json::from_str::<Value>(line) else {
        return;
    };
    match str_field(&record, "type").as_deref() {
        Some("custom-title") => {
            facts.title = str_field(&record, "customTitle");
            facts.title_custom = true;
            return;
        }
        Some("ai-title") => {
            // A rename outranks every generated title, as in every lister.
            if !facts.title_custom {
                facts.title = str_field(&record, "aiTitle");
            }
            return;
        }
        _ => {}
    }
    if record.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return;
    }
    if let Some(cwd) = str_field(&record, "cwd") {
        facts.cwd = Some(cwd);
    }
    if let Some(branch) = str_field(&record, "gitBranch").filter(|b| !b.is_empty()) {
        facts.branch = Some(branch);
    }
    let Some(message) = record.get("message") else {
        return;
    };
    let conversational = match str_field(&record, "type").as_deref() {
        Some("assistant") => {
            note_assistant(message, facts);
            true
        }
        Some("user") => {
            note_user(&record, message, facts);
            !is_tool_result(message) && !is_synthetic_echo(message)
        }
        _ => false,
    };
    if conversational {
        if let Some(timestamp) = str_field(&record, "timestamp") {
            facts.last_ms = facts.last_ms.max(crate::stats::parse_iso_ms(&timestamp));
        }
    }
}

/// Fold a whole transcript.
pub fn read_facts(path: &Path) -> std::io::Result<Facts> {
    let reader = BufReader::new(File::open(path)?);
    let mut facts = Facts::default();
    for line in reader.lines() {
        fold_line(&line?, &mut facts);
    }
    Ok(facts)
}

/* ---------- what the repo says ---------- */

/// What git says now about the repo a session ran in.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoFacts {
    /// `cwd` is a work tree git can answer for.
    pub is_repo: bool,
    /// Uncommitted changes to paths the session wrote through a write tool.
    pub dirty_written: u64,
    /// Uncommitted changes anywhere in the repo. Weak: not necessarily this
    /// session's, but most of its writes are invisible to `dirty_written`.
    pub dirty_repo: u64,
    /// The session's branch no longer exists locally.
    pub branch_gone: bool,
    /// The session's branch is contained in the trunk.
    pub branch_merged: bool,
    /// Commits on the session's branch not on its upstream.
    pub unpushed: u64,
}

fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let output = crate::env::with_child_path(&mut Command::new("git"))
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

fn trunk_ref(cwd: &str) -> Option<String> {
    [
        "origin/HEAD",
        "origin/main",
        "origin/master",
        "main",
        "master",
    ]
    .iter()
    .find(|candidate| git(cwd, &["rev-parse", "--verify", "--quiet", candidate]).is_some())
    .map(|found| (*found).to_string())
}

/// Ask git about the repo a session ran in. Slow-ish: several processes.
pub fn read_repo_facts(facts: &Facts) -> RepoFacts {
    let Some(cwd) = facts.cwd.as_deref().filter(|cwd| Path::new(cwd).is_dir()) else {
        return RepoFacts::default();
    };
    let Some(status) = git(cwd, &["status", "--porcelain"]) else {
        return RepoFacts::default();
    };
    let root = git(cwd, &["rev-parse", "--show-toplevel"])
        .map(|root| root.trim().to_string())
        .unwrap_or_default();
    let dirty: Vec<&str> = status.lines().filter_map(|line| line.get(3..)).collect();
    let dirty_written = facts
        .written
        .iter()
        .filter_map(|path| path.strip_prefix(&format!("{root}/")))
        .filter(|rel| dirty.iter().any(|entry| entry == rel))
        .count() as u64;

    let mut repo = RepoFacts {
        is_repo: true,
        dirty_written,
        dirty_repo: dirty.len() as u64,
        ..RepoFacts::default()
    };
    let Some(branch) = facts
        .branch
        .as_deref()
        .filter(|b| !TRUNK_BRANCHES.contains(b))
    else {
        return repo;
    };
    let local = format!("refs/heads/{branch}");
    if git(cwd, &["rev-parse", "--verify", "--quiet", &local]).is_none() {
        repo.branch_gone = true;
        return repo;
    }
    if let Some(trunk) = trunk_ref(cwd) {
        repo.branch_merged = git(cwd, &["merge-base", "--is-ancestor", &local, &trunk]).is_some();
    }
    let range = format!("{branch}@{{upstream}}..{branch}");
    repo.unpushed = git(cwd, &["rev-list", "--count", &range])
        .and_then(|count| count.trim().parse().ok())
        .unwrap_or(0);
    repo
}

/* ---------- the verdict ---------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Shape {
    /// A quick ask: done once it finishes and you have seen it.
    Errand,
    /// A line of work: parks when you walk away, closes on evidence.
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// Still being talked to; too soon to call.
    Live,
    Done,
    Parked,
    /// No evidence either way. The slot a model call would fill.
    Unclear,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub shape: Shape,
    pub outcome: Outcome,
    /// Why, as short tags: the evidence behind the call.
    pub reasons: Vec<String>,
    /// Where you left off, when the verdict is `Parked`.
    pub next_step: Option<String>,
}

fn on_side_branch(facts: &Facts) -> bool {
    facts
        .branch
        .as_deref()
        .is_some_and(|b| !TRUNK_BRANCHES.contains(&b))
}

pub fn shape_of(facts: &Facts) -> Shape {
    let multi_day = facts.days.len() >= 2;
    let long = facts.prompts >= PROJECT_PROMPTS;
    let shipped_code = facts.commits > 0 && facts.prompts >= 3;
    let own_branch = on_side_branch(facts) && (facts.commits > 0 || !facts.written.is_empty());
    if multi_day || long || shipped_code || own_branch {
        Shape::Project
    } else {
        Shape::Errand
    }
}

/// The last assistant text ends with work still on the table.
fn ends_with_offer(text: &str) -> bool {
    let lower = text.to_lowercase();
    let last = tail_chars(&lower, 200);
    last.trim_end().ends_with('?') || OFFER_PHRASES.iter().any(|phrase| last.contains(phrase))
}

fn is_wrap_up(prompt: &str) -> bool {
    // Whole words, padded, so "ok" does not match inside "look".
    let words: Vec<String> = prompt
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect();
    let padded = format!(" {} ", words.join(" "));
    words.len() <= 6 && WRAP_UPS.iter().any(|w| padded.contains(&format!(" {w} ")))
}

/// The sentence the offer is in, as the note for where you left off.
fn offer_sentence(text: &str) -> String {
    let trimmed = text.trim_end();
    let cut = trimmed[..trimmed.len().saturating_sub(1)]
        .rfind(['.', '!', '\n'])
        .map(|at| at + 1)
        .unwrap_or(0);
    trimmed[cut..].trim().to_string()
}

pub fn decide(facts: &Facts, repo: &RepoFacts, now_ms: u64) -> Verdict {
    let shape = shape_of(facts);
    let mut open: Vec<String> = Vec::new();
    let mut done: Vec<String> = Vec::new();

    if facts.awaiting {
        open.push("awaiting-you".into());
    }
    if facts.interrupted {
        open.push("interrupted".into());
    }
    if repo.dirty_written > 0 {
        open.push(format!("uncommitted:{}", repo.dirty_written));
    }
    if repo.unpushed > 0 {
        open.push(format!("unpushed:{}", repo.unpushed));
    }
    if facts.commits > 0 && !facts.pushed && repo.unpushed == 0 && !repo.branch_merged {
        open.push("commits-no-push-seen".into());
    }
    if facts.pr_opened && !facts.pr_merged && !repo.branch_merged && !repo.branch_gone {
        open.push("pr-open".into());
    }
    let offer = facts
        .last_assistant
        .as_deref()
        .filter(|text| facts.last_role.as_deref() == Some("assistant") && ends_with_offer(text));
    if offer.is_some() {
        open.push("offer-unanswered".into());
    }

    if repo.branch_merged {
        done.push("branch-merged".into());
    }
    if repo.branch_gone {
        done.push("branch-gone".into());
    }
    if facts.pr_merged {
        done.push("pr-merged".into());
    }
    if facts.pushed && repo.unpushed == 0 && repo.dirty_written == 0 {
        done.push("pushed".into());
    }
    if !facts.delivered.is_empty() {
        let list: Vec<&str> = facts.delivered.iter().map(String::as_str).collect();
        done.push(format!("delivered:{}", list.join("+")));
    }
    if facts.last_prompt.as_deref().is_some_and(is_wrap_up) {
        done.push("wrap-up".into());
    }
    if facts.written.is_empty() && facts.commits == 0 && repo.dirty_written == 0 {
        done.push("no-edits-seen".into());
    }

    let quiet = now_ms.saturating_sub(facts.last_ms);
    let hard_open = facts.awaiting || facts.interrupted || repo.dirty_written > 0;
    let outcome = if quiet < WALK_AWAY_MS {
        Outcome::Live
    } else {
        match shape {
            // An errand you walked away from with an offer on the table is one
            // you did not want: only a blocked or half-written one is owed.
            Shape::Errand if hard_open => Outcome::Parked,
            Shape::Errand => Outcome::Done,
            // A false done hides work you owe; a false park costs a click. So a
            // project needs evidence to close, and any open signal parks it.
            Shape::Project if !open.is_empty() => Outcome::Parked,
            Shape::Project if done.iter().any(|d| d != "no-edits-seen") => Outcome::Done,
            Shape::Project => Outcome::Unclear,
        }
    };

    let next_step = (outcome == Outcome::Parked || outcome == Outcome::Unclear)
        .then(|| {
            offer
                .map(offer_sentence)
                .or_else(|| facts.last_prompt.clone())
        })
        .flatten();

    let mut reasons = open;
    reasons.extend(done.into_iter().map(|d| format!("+{d}")));
    Verdict {
        shape,
        outcome,
        reasons,
        next_step,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: u64 = 3_600_000;

    fn user(text: &str, ts: &str) -> String {
        serde_json::json!({
            "type": "user", "timestamp": ts, "cwd": "/nowhere", "gitBranch": "main",
            "message": {"role": "user", "content": text}
        })
        .to_string()
    }

    fn assistant(text: &str, ts: &str) -> String {
        serde_json::json!({
            "type": "assistant", "timestamp": ts,
            "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}
        })
        .to_string()
    }

    fn tool(name: &str, input: Value, ts: &str) -> String {
        serde_json::json!({
            "type": "assistant", "timestamp": ts,
            "message": {"role": "assistant", "content": [
                {"type": "tool_use", "id": "t1", "name": name, "input": input}
            ]}
        })
        .to_string()
    }

    fn facts_of(lines: &[String]) -> Facts {
        let mut facts = Facts::default();
        for line in lines {
            fold_line(line, &mut facts);
        }
        facts
    }

    fn later(facts: &Facts) -> u64 {
        facts.last_ms + 2 * HOUR
    }

    #[test]
    fn one_question_answered_is_a_done_errand() {
        let facts = facts_of(&[
            user("what does this flag do", "2026-09-01T10:00:00.000Z"),
            assistant("It sets the timeout.", "2026-09-01T10:00:05.000Z"),
        ]);
        let verdict = decide(&facts, &RepoFacts::default(), later(&facts));
        assert_eq!(verdict.shape, Shape::Errand);
        assert_eq!(verdict.outcome, Outcome::Done);
    }

    #[test]
    fn recent_session_is_live_whatever_it_says() {
        let facts = facts_of(&[
            user("fix it", "2026-09-01T10:00:00.000Z"),
            assistant("Want me to push?", "2026-09-01T10:00:05.000Z"),
        ]);
        let verdict = decide(&facts, &RepoFacts::default(), facts.last_ms + 60_000);
        assert_eq!(verdict.outcome, Outcome::Live);
    }

    #[test]
    fn multi_day_session_is_a_project() {
        let facts = facts_of(&[
            user("start", "2026-09-01T10:00:00.000Z"),
            user("continue", "2026-09-03T10:00:00.000Z"),
        ]);
        assert_eq!(shape_of(&facts), Shape::Project);
    }

    #[test]
    fn project_ending_on_an_offer_parks_with_the_offer_as_note() {
        let mut lines: Vec<String> = (0..7)
            .map(|i| user(&format!("step {i}"), "2026-09-01T10:00:00.000Z"))
            .collect();
        lines.push(assistant(
            "Rail is done. Want me to build the logbook next?",
            "2026-09-01T11:00:00.000Z",
        ));
        let facts = facts_of(&lines);
        let verdict = decide(&facts, &RepoFacts::default(), later(&facts));
        assert_eq!(verdict.outcome, Outcome::Parked);
        assert_eq!(
            verdict.next_step.as_deref(),
            Some("Want me to build the logbook next?")
        );
    }

    #[test]
    fn errand_ending_on_an_offer_is_still_done() {
        let facts = facts_of(&[
            user("what is my ip", "2026-09-01T10:00:00.000Z"),
            assistant(
                "10.0.0.1. Want me to check DNS too?",
                "2026-09-01T10:00:05.000Z",
            ),
        ]);
        let verdict = decide(&facts, &RepoFacts::default(), later(&facts));
        assert_eq!(verdict.outcome, Outcome::Done);
    }

    #[test]
    fn unanswered_question_parks_even_an_errand() {
        let facts = facts_of(&[
            user("deploy it", "2026-09-01T10:00:00.000Z"),
            tool(
                "AskUserQuestion",
                serde_json::json!({}),
                "2026-09-01T10:00:05.000Z",
            ),
        ]);
        let verdict = decide(&facts, &RepoFacts::default(), later(&facts));
        assert_eq!(verdict.outcome, Outcome::Parked);
        assert!(verdict.reasons.contains(&"awaiting-you".to_string()));
    }

    #[test]
    fn delivery_closes_a_project() {
        let mut lines: Vec<String> = (0..7)
            .map(|i| user(&format!("step {i}"), "2026-09-01T10:00:00.000Z"))
            .collect();
        lines.push(tool(
            "mcp__claude_ai_Slack__slack_send_message",
            serde_json::json!({}),
            "2026-09-01T11:00:00.000Z",
        ));
        lines.push(assistant("Posted.", "2026-09-01T11:00:05.000Z"));
        let facts = facts_of(&lines);
        let verdict = decide(&facts, &RepoFacts::default(), later(&facts));
        assert_eq!(verdict.outcome, Outcome::Done);
    }

    #[test]
    fn project_without_evidence_is_unclear() {
        let mut lines: Vec<String> = (0..7)
            .map(|i| user(&format!("look at {i}"), "2026-09-01T10:00:00.000Z"))
            .collect();
        lines.push(assistant(
            "That is how it works.",
            "2026-09-01T11:00:00.000Z",
        ));
        let facts = facts_of(&lines);
        let verdict = decide(&facts, &RepoFacts::default(), later(&facts));
        assert_eq!(verdict.outcome, Outcome::Unclear);
    }

    #[test]
    fn git_push_in_bash_is_seen() {
        let facts = facts_of(&[tool(
            "Bash",
            serde_json::json!({"command": "git push -u origin feat"}),
            "2026-09-01T10:00:00.000Z",
        )]);
        assert!(facts.pushed);
    }

    #[test]
    fn wrap_up_is_short_and_closing() {
        assert!(is_wrap_up("ok thanks"));
        assert!(!is_wrap_up(
            "thanks, now also rewrite the parser and add tests for it"
        ));
        assert!(!is_wrap_up("look at the logs"));
    }
}
