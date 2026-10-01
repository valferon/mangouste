//! Dump a done/parked verdict for every transcript under ~/.claude/projects.
//!
//!     cargo run --example verdicts            # table
//!     cargo run --example verdicts -- --json  # one JSON object per line
//!
//! Read-only: folds transcripts and asks git about the repos they ran in.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use mangouste_lib::verdict::{decide, read_facts, read_repo_facts};

fn transcripts() -> Vec<PathBuf> {
    let Some(root) = dirs::home_dir().map(|h| h.join(".claude").join("projects")) else {
        return Vec::new();
    };
    let Ok(dirs) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = dirs
        .flatten()
        .map(|d| d.path())
        // The title helper's scratch sessions, which the rail hides too.
        .filter(|d| !d.to_string_lossy().contains("mangouste-titlegen"))
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flat_map(|entries| entries.flatten().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    out.sort();
    out
}

fn short(text: &str, chars: usize) -> String {
    let flat: String = text.chars().take(chars).collect();
    if text.chars().count() > chars {
        format!("{flat}…")
    } else {
        flat
    }
}

fn main() {
    let json = std::env::args().any(|a| a == "--json");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    for path in transcripts() {
        let Ok(facts) = read_facts(&path) else {
            continue;
        };
        if facts.prompts == 0 {
            continue;
        }
        let repo = read_repo_facts(&facts);
        let verdict = decide(&facts, &repo, now);
        let id = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        if json {
            let row = serde_json::json!({
                "id": id, "facts": facts, "repo": repo, "verdict": verdict,
            });
            println!("{row}");
            continue;
        }
        let age_h = now.saturating_sub(facts.last_ms) / 3_600_000;
        println!(
            "{:<8} {:<7} {:>5}h {:>3}p {:>2}d  {}  {}\n    {}{}",
            format!("{:?}", verdict.outcome),
            format!("{:?}", verdict.shape),
            age_h,
            facts.prompts,
            facts.days.len(),
            &id[..8.min(id.len())],
            short(facts.title.as_deref().unwrap_or("(untitled)"), 60),
            verdict.reasons.join(" "),
            verdict
                .next_step
                .map(|n| format!("\n    next: {}", short(&n, 110)))
                .unwrap_or_default(),
        );
    }
}
