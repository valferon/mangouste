//! Threads: the long-lived pieces of work that sessions belong to.
//!
//! A session ends; the work it was part of often does not. Before this, the only
//! handle on "this continues" was the session's own title — `[TBC] …` typed in
//! by hand — which ages out of the rail with the session and says nothing about
//! where things were left. A thread is that handle made real: a title, a status
//! only you change, the sessions under it, a "where it stands / next" note, and
//! a dated log.
//!
//! Stored as one markdown file per thread in the app's data directory, never in
//! a repo and never anywhere shared: this is work in progress, and it is nobody
//! else's to read. The directory is owner-only, and the files are plain enough
//! to grep, edit by hand, or keep if this app goes away. A hand edit survives a
//! save: body sections this module does not know are carried through verbatim.
//! Frontmatter is this module's own — keys it does not know are dropped — so
//! anything of yours goes in a section of its own.
//!
//! ```text
//! ---
//! title: DLP rollout
//! status: open
//! created: 2026-09-29T10:00:00.000Z
//! updated: 2026-09-29T10:00:00.000Z
//! ---
//!
//! ## Next
//!
//! Refine the policy set with the client, then the Google side.
//!
//! ## Sessions
//!
//! - 47c10375-… · 2026-09-24T14:05:00.000Z · /home/me/playground · DLP first pass
//!
//! ## Log
//!
//! - 2026-09-29T10:00:00.000Z · opened from 47c10375
//! ```

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::sessions::{format_timestamp_ms, now_ms};

pub const EVENT_THREADS_CHANGED: &str = "threads://changed";

/// Longest title kept. A title is a label, not a description.
const TITLE_MAX_CHARS: usize = 200;

/// Longest note kept. Far past anything typed; a cap on a pasted transcript.
const NOTE_MAX_BYTES: usize = 64 * 1024;

/// Longest slug. File names stay readable and well inside every OS limit.
const SLUG_MAX_CHARS: usize = 48;

const STATUSES: [&str; 3] = ["open", "blocked", "done"];

/// Field separator in the list sections. Chosen because it never appears in a
/// uuid or a timestamp, so only the last field — free text — can contain it.
const SEP: &str = " · ";

/* ---------- the model ---------- */

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSession {
    pub id: String,
    /// When it was attached, as a transcript timestamp.
    pub added: String,
    pub cwd: String,
    /// The session's title when it was attached, so the thread still reads
    /// after the transcript is gone.
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub at: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    /// The file stem. Fixed at creation: a rename changes the title, not this.
    pub id: String,
    pub title: String,
    pub status: String,
    pub created: String,
    pub updated: String,
    pub note: String,
    pub sessions: Vec<ThreadSession>,
    pub log: Vec<LogLine>,
    /// Sections this module does not own, verbatim, so a hand edit survives.
    #[serde(default)]
    pub extra: String,
}

/* ---------- the file format ---------- */

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn render(thread: &Thread) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("title: {}\n", one_line(&thread.title)));
    out.push_str(&format!("status: {}\n", thread.status));
    out.push_str(&format!("created: {}\n", thread.created));
    out.push_str(&format!("updated: {}\n", thread.updated));
    out.push_str("---\n\n## Next\n\n");
    let note = escape_headings(thread.note.trim());
    if !note.is_empty() {
        out.push_str(&note);
        out.push_str("\n\n");
    }
    out.push_str("## Sessions\n\n");
    for s in &thread.sessions {
        out.push_str(&format!(
            "- {}{SEP}{}{SEP}{}{SEP}{}\n",
            s.id,
            s.added,
            one_line(&s.cwd),
            one_line(&s.title)
        ));
    }
    if !thread.sessions.is_empty() {
        out.push('\n');
    }
    out.push_str("## Log\n\n");
    for line in &thread.log {
        out.push_str(&format!("- {}{SEP}{}\n", line.at, one_line(&line.text)));
    }
    let extra = thread.extra.trim();
    if !extra.is_empty() {
        out.push('\n');
        out.push_str(extra);
        out.push('\n');
    }
    out
}

/// A note line that reads as a section heading would be split off into a
/// section of its own on the next load. One backslash more on each such line —
/// including one already escaped — keeps the mapping reversible.
fn escape_headings(note: &str) -> String {
    note.lines()
        .map(|line| {
            if line.trim_start_matches('\\').starts_with("## ") {
                format!("\\{line}")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn unescape_headings(note: &str) -> String {
    note.lines()
        .map(|line| match line.strip_prefix('\\') {
            Some(rest) if rest.trim_start_matches('\\').starts_with("## ") => rest.to_string(),
            _ => line.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn list_items(body: &str) -> impl Iterator<Item = &str> {
    body.lines()
        .filter_map(|line| line.trim().strip_prefix("- "))
}

/// Parse a thread file. `id` is the file stem, which the file does not repeat.
pub fn parse(id: &str, text: &str) -> Option<Thread> {
    // A file saved by a Windows editor must still load, not vanish from the list.
    let text = text.replace("\r\n", "\n");
    let rest = text.strip_prefix("---\n")?;
    let (front, body) = rest.split_once("\n---\n")?;
    let mut thread = Thread {
        id: id.to_string(),
        title: id.to_string(),
        status: "open".to_string(),
        created: String::new(),
        updated: String::new(),
        note: String::new(),
        sessions: Vec::new(),
        log: Vec::new(),
        extra: String::new(),
    };
    for line in front.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().to_string();
        match key.trim() {
            "title" if !value.is_empty() => thread.title = value,
            "status" if STATUSES.contains(&value.as_str()) => thread.status = value,
            "created" => thread.created = value,
            "updated" => thread.updated = value,
            _ => {}
        }
    }

    // Split on level-two headings at the start of a line. Anything before the
    // first heading, or under a heading this module does not own, is extra.
    let mut sections: Vec<(Option<String>, String)> = vec![(None, String::new())];
    for line in body.lines() {
        if let Some(name) = line.strip_prefix("## ") {
            sections.push((Some(name.trim().to_string()), String::new()));
            continue;
        }
        if let Some((_, content)) = sections.last_mut() {
            content.push_str(line);
            content.push('\n');
        }
    }
    let mut extra: Vec<String> = Vec::new();
    for (name, content) in sections {
        match name.as_deref() {
            Some("Next") => thread.note = unescape_headings(content.trim()),
            Some("Sessions") => {
                for item in list_items(&content) {
                    let parts: Vec<&str> = item.splitn(4, SEP).collect();
                    if parts.len() < 2 || parts[0].is_empty() {
                        continue;
                    }
                    thread.sessions.push(ThreadSession {
                        id: parts[0].trim().to_string(),
                        added: parts[1].trim().to_string(),
                        cwd: parts.get(2).map(|s| s.trim()).unwrap_or("").to_string(),
                        title: parts.get(3).map(|s| s.trim()).unwrap_or("").to_string(),
                    });
                }
            }
            Some("Log") => {
                for item in list_items(&content) {
                    if let Some((at, text)) = item.split_once(SEP) {
                        thread.log.push(LogLine {
                            at: at.trim().to_string(),
                            text: text.trim().to_string(),
                        });
                    }
                }
            }
            Some(other) => {
                extra.push(format!("## {other}\n\n{}", content.trim()));
            }
            None if !content.trim().is_empty() => extra.push(content.trim().to_string()),
            None => {}
        }
    }
    thread.extra = extra.join("\n\n");
    Some(thread)
}

/// A file stem from a title: lowercase ascii words joined by dashes.
pub fn slugify(title: &str) -> String {
    let mut slug = String::new();
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
        if slug.len() >= SLUG_MAX_CHARS {
            break;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "thread".to_string()
    } else {
        slug
    }
}

/// An id that names a file inside the store and nothing else. Every id the
/// frontend sends comes through here, so no path can escape the directory.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= SLUG_MAX_CHARS + 8
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !id.starts_with('-')
}

/* ---------- the store ---------- */

/// Serialises writes, so two windows saving at once cannot interleave a
/// read-modify-write of the same file.
#[derive(Default)]
pub struct ThreadStore {
    lock: Mutex<()>,
}

pub fn store_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("MANGOUSTE_THREADS_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    dirs::data_dir().map(|d| d.join("mangouste").join("threads"))
}

fn ensure_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Write through a temp file and a rename, owner-only, so a crash mid-write
/// leaves the old file rather than half a new one.
fn write_file(path: &Path, text: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("md.tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    fs::rename(&tmp, path)
}

pub fn read_all(dir: &Path) -> Vec<Thread> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut threads: Vec<Thread> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "md"))
        .filter_map(|p| {
            let id = p.file_stem()?.to_str()?.to_string();
            if !valid_id(&id) {
                return None;
            }
            parse(&id, &fs::read_to_string(&p).ok()?)
        })
        .collect();
    threads.sort_by(|a, b| b.updated.cmp(&a.updated));
    threads
}

fn clean(mut thread: Thread) -> Result<Thread, String> {
    if !valid_id(&thread.id) {
        return Err("invalid thread id".into());
    }
    if !STATUSES.contains(&thread.status.as_str()) {
        return Err(format!("invalid thread status: {}", thread.status));
    }
    thread.title = one_line(&thread.title)
        .chars()
        .take(TITLE_MAX_CHARS)
        .collect();
    if thread.title.is_empty() {
        return Err("a thread needs a title".into());
    }
    if thread.note.len() > NOTE_MAX_BYTES {
        return Err("note is too long".into());
    }
    thread.updated = format_timestamp_ms(now_ms());
    if thread.created.is_empty() {
        thread.created = thread.updated.clone();
    }
    Ok(thread)
}

fn save_in(dir: &Path, thread: Thread) -> Result<Thread, String> {
    let thread = clean(thread)?;
    ensure_dir(dir).map_err(|e| e.to_string())?;
    write_file(&dir.join(format!("{}.md", thread.id)), &render(&thread))
        .map_err(|e| e.to_string())?;
    Ok(thread)
}

fn create_in(dir: &Path, title: &str, session: Option<ThreadSession>) -> Result<Thread, String> {
    let base = slugify(title);
    let taken = |id: &str| dir.join(format!("{id}.md")).exists();
    let id = (1..)
        .map(|n| {
            if n == 1 {
                base.clone()
            } else {
                format!("{base}-{n}")
            }
        })
        .find(|id| !taken(id))
        .unwrap_or(base);
    let now = format_timestamp_ms(now_ms());
    let opened = match &session {
        Some(s) => format!("opened from {}", s.id.get(..8).unwrap_or(&s.id)),
        None => "opened".to_string(),
    };
    save_in(
        dir,
        Thread {
            id,
            title: title.to_string(),
            status: "open".to_string(),
            created: now.clone(),
            updated: now.clone(),
            note: String::new(),
            sessions: session.into_iter().collect(),
            log: vec![LogLine {
                at: now,
                text: opened,
            }],
            extra: String::new(),
        },
    )
}

fn dir_or_err() -> Result<PathBuf, String> {
    store_dir().ok_or_else(|| "no data directory for threads".to_string())
}

#[tauri::command]
pub fn threads_list(store: State<'_, ThreadStore>) -> Result<Vec<Thread>, String> {
    let _guard = store.lock.lock();
    Ok(read_all(&dir_or_err()?))
}

#[tauri::command]
pub fn thread_create(
    app: AppHandle,
    store: State<'_, ThreadStore>,
    title: String,
    session: Option<ThreadSession>,
) -> Result<Thread, String> {
    let thread = {
        let _guard = store.lock.lock();
        create_in(&dir_or_err()?, &title, session)?
    };
    let _ = app.emit(EVENT_THREADS_CHANGED, ());
    Ok(thread)
}

#[tauri::command]
pub fn thread_save(
    app: AppHandle,
    store: State<'_, ThreadStore>,
    thread: Thread,
) -> Result<Thread, String> {
    let thread = {
        let _guard = store.lock.lock();
        let dir = dir_or_err()?;
        // Saving is for threads that exist. A stale id from another window must
        // not quietly recreate a file that was just removed by hand.
        let path = dir.join(format!("{}.md", thread.id));
        let Some(on_disk) = fs::read_to_string(&path)
            .ok()
            .and_then(|text| parse(&thread.id, &text))
        else {
            return Err("thread no longer exists".into());
        };
        // The edit was made against the version with this `updated`. Anything
        // newer on disk came from another window or a hand edit, and saving over
        // it would silently drop that change.
        if on_disk.updated != thread.updated {
            return Err("thread changed elsewhere; reloaded, try again".into());
        }
        save_in(&dir, thread)?
    };
    let _ = app.emit(EVENT_THREADS_CHANGED, ());
    Ok(thread)
}

/// Where a thread lives on disk, for "reveal".
#[tauri::command]
pub fn thread_path(id: String) -> Result<String, String> {
    if !valid_id(&id) {
        return Err("invalid thread id".into());
    }
    Ok(dir_or_err()?
        .join(format!("{id}.md"))
        .to_string_lossy()
        .into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Thread {
        Thread {
            id: "dlp-rollout".into(),
            title: "DLP rollout".into(),
            status: "open".into(),
            created: "2026-09-29T10:00:00.000Z".into(),
            updated: "2026-09-29T10:00:00.000Z".into(),
            note: "Refine policies.\n\nThen the Google side.".into(),
            sessions: vec![ThreadSession {
                id: "47c10375-ff4e".into(),
                added: "2026-09-24T14:05:00.000Z".into(),
                cwd: "/home/me/playground".into(),
                title: "first pass · with a dot".into(),
            }],
            log: vec![LogLine {
                at: "2026-09-29T10:00:00.000Z".into(),
                text: "opened".into(),
            }],
            extra: String::new(),
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mangouste-threads-test-{name}-{}", now_ms()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn render_then_parse_is_identity() {
        let thread = sample();
        assert_eq!(parse(&thread.id, &render(&thread)), Some(thread));
    }

    #[test]
    fn heading_lines_in_a_note_stay_in_the_note() {
        let mut thread = sample();
        thread.note = "first\n## not a section\n\\## already escaped\nlast".into();
        let parsed = parse(&thread.id, &render(&thread)).expect("parses");
        assert_eq!(parsed.note, thread.note);
        assert_eq!(parsed.extra, "");
    }

    #[test]
    fn crlf_files_load() {
        let text = render(&sample()).replace('\n', "\r\n");
        assert_eq!(parse("dlp-rollout", &text), Some(sample()));
    }

    #[test]
    fn unknown_sections_survive_a_round_trip() {
        let text = render(&sample()) + "\n## Contacts\n\nsomeone, somewhere\n";
        let parsed = parse("dlp-rollout", &text).expect("parses");
        assert!(parsed.extra.contains("## Contacts"));
        let again = parse("dlp-rollout", &render(&parsed)).expect("parses");
        assert_eq!(again.extra, parsed.extra);
    }

    #[test]
    fn bad_status_in_file_falls_back_to_open() {
        let text = render(&sample()).replace("status: open", "status: wat");
        assert_eq!(parse("x", &text).map(|t| t.status).as_deref(), Some("open"));
    }

    #[test]
    fn slug_is_file_safe() {
        assert_eq!(
            slugify("[TBC] DLP / Cyera + Google!"),
            "tbc-dlp-cyera-google"
        );
        assert_eq!(slugify("???"), "thread");
        assert!(slugify(&"a".repeat(500)).len() <= SLUG_MAX_CHARS);
    }

    #[test]
    fn ids_cannot_escape_the_store() {
        assert!(valid_id("dlp-rollout-2"));
        assert!(!valid_id("../etc/passwd"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id(""));
        assert!(!valid_id("-x"));
    }

    #[test]
    fn create_dedupes_ids_and_logs_origin() {
        let dir = scratch("create");
        let session = ThreadSession {
            id: "47c10375-ff4e".into(),
            added: "2026-09-24T14:05:00.000Z".into(),
            cwd: "/tmp".into(),
            title: "t".into(),
        };
        let first = create_in(&dir, "DLP", Some(session)).expect("creates");
        let second = create_in(&dir, "DLP", None).expect("creates");
        assert_eq!(first.id, "dlp");
        assert_eq!(second.id, "dlp-2");
        assert_eq!(first.log[0].text, "opened from 47c10375");
        assert_eq!(read_all(&dir).len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn store_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("perms");
        let thread = create_in(&dir, "Private", None).expect("creates");
        let mode = |p: &Path| fs::metadata(p).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join(format!("{}.md", thread.id))), 0o600);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_rejects_bad_input() {
        let dir = scratch("reject");
        let mut bad = sample();
        bad.status = "whatever".into();
        assert!(save_in(&dir, bad).is_err());
        let mut empty = sample();
        empty.title = "   ".into();
        assert!(save_in(&dir, empty).is_err());
        let mut escape = sample();
        escape.id = "../x".into();
        assert!(save_in(&dir, escape).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
