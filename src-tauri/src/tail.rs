//! Following a tool's output while it runs.
//!
//! The CLI points a Bash call's stdout and stderr at a `tasks/<id>.output` file
//! rather than a pipe, foreground or backgrounded, and a command that redirects
//! its own output (`ansible-playbook ... > run.log`) has fd 1 on that log
//! instead. Either way the file can be read without touching the process, so
//! following a command is tailing a file.
//!
//! The pane asks for tails by path, so `tool_output_tail` is a file read over
//! IPC and must not be a general one: it serves only files the liveness probe
//! itself found on a tool's fd 1, and the CLI's own task output files.

use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use parking_lot::Mutex;
use serde::Serialize;

/// Upper bound on what the pane can ask for when following.
const MAX_FOLLOW_LINES: usize = 2000;
/// Bytes read per requested line. Generous: ansible and build logs run long.
const BYTES_PER_LINE: u64 = 256;
/// Characters kept per line before it is cut.
const MAX_LINE_CHARS: usize = 400;

/// Output files the probe has seen on a running tool's stdout. Only ever
/// grows, but by one path per distinct command, and paths are short.
static FOLLOWABLE: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Default::default);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tail {
    pub text: String,
    /// Size of the whole file, so the pane can say how much it is not showing.
    pub bytes: u64,
    /// Last write, the only progress signal a quiet command gives.
    pub mtime_ms: u64,
}

/// The regular file a process's stdout is on, if it is on one.
///
/// A pipe, tty or `/dev/null` is not a regular file and yields None. The path
/// is remembered as followable. Off Linux there is no cheap equivalent.
#[cfg(target_os = "linux")]
pub(crate) fn output_file_of(pid: u32) -> Option<String> {
    let fd = format!("/proc/{pid}/fd/1");
    if !std::fs::metadata(&fd).ok()?.is_file() {
        return None;
    }
    let target = std::fs::read_link(&fd).ok()?;
    // An unlinked file reads as "path (deleted)" and cannot be reopened by name.
    if !target.is_absolute() || !target.exists() {
        return None;
    }
    FOLLOWABLE.lock().insert(target.clone());
    Some(target.to_string_lossy().into_owned())
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn output_file_of(_pid: u32) -> Option<String> {
    None
}

/// Last `lines` displayable lines of the file at `path`.
fn read_tail(path: &str, lines: usize) -> Option<Tail> {
    let mut file = std::fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() {
        return None;
    }
    let budget = lines as u64 * BYTES_PER_LINE;
    let start = meta.len().saturating_sub(budget);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut chunk = Vec::new();
    file.take(budget).read_to_end(&mut chunk).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(Tail {
        text: shape_tail(&chunk, lines, start > 0).unwrap_or_default(),
        bytes: meta.len(),
        mtime_ms,
    })
}

/// The pane's follow view. None when the file is gone or not one it may read.
#[tauri::command]
pub fn tool_output_tail(path: String, lines: usize) -> Result<Option<Tail>, String> {
    if !followable(Path::new(&path)) {
        return Err(format!("not a tool output file: {path}"));
    }
    Ok(read_tail(&path, lines.clamp(1, MAX_FOLLOW_LINES)))
}

fn followable(path: &Path) -> bool {
    if FOLLOWABLE.lock().contains(path) {
        return true;
    }
    // Resolved first, so `..` or a symlink cannot walk a task-shaped path
    // somewhere else.
    std::fs::canonicalize(path)
        .map(|real| is_task_output(&real))
        .unwrap_or(false)
}

/// `.../claude-<uid>/<project>/<session>/tasks/<id>.output`, the shape the CLI
/// gives every Bash call's output and quotes in a backgrounded call's result.
fn is_task_output(path: &Path) -> bool {
    let named = path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with(".output"));
    let in_tasks = path
        .parent()
        .and_then(|p| p.file_name())
        .is_some_and(|n| n == "tasks");
    let under_claude = path.ancestors().any(|dir| {
        dir.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("claude-"))
    });
    path.is_absolute() && named && in_tasks && under_claude
}

/// Last few displayable lines of raw terminal output.
///
/// Escape sequences go (colour, cursor moves), a `\r`-redrawn progress line
/// keeps only its final state, blank lines drop, and each line is capped. With
/// `partial` the read started mid-file, so its first line is a fragment and
/// goes too.
fn shape_tail(raw: &[u8], max_lines: usize, partial: bool) -> Option<String> {
    let text = strip_ansi(&String::from_utf8_lossy(raw));
    let mut lines: Vec<&str> = text.split('\n').collect();
    if partial && lines.len() > 1 {
        lines.remove(0);
    }
    let shaped: Vec<String> = lines
        .iter()
        .map(|line| {
            let line = line.trim_end_matches('\r');
            let line = line.rsplit('\r').next().unwrap_or(line).trim_end();
            if line.chars().count() > MAX_LINE_CHARS {
                let cut: String = line.chars().take(MAX_LINE_CHARS).collect();
                format!("{cut}…")
            } else {
                line.to_string()
            }
        })
        .filter(|line| !line.trim().is_empty())
        .collect();
    let start = shaped.len().saturating_sub(max_lines);
    let tail = shaped[start..].join("\n");
    (!tail.is_empty()).then_some(tail)
}

/// Drop CSI (`ESC [ ... final`) and OSC (`ESC ] ... BEL|ST`) sequences, plus
/// any other two-byte escape.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shape_tail_keeps_the_last_clean_lines() {
        let raw = b"\x1b[0;32mok: [host]\x1b[0m\n\nTASK [x] ***\r\n10%\r55%\r100%\n";
        assert_eq!(
            shape_tail(raw, 8, false).as_deref(),
            Some("ok: [host]\nTASK [x] ***\n100%")
        );
        assert_eq!(shape_tail(b"\n \n", 8, false), None);
        let many: String = (0..20).map(|i| format!("line {i}\n")).collect();
        let shaped = shape_tail(many.as_bytes(), 8, false).expect("shaped");
        assert_eq!(shaped.lines().count(), 8);
        assert!(shaped.ends_with("line 19"));
    }

    #[test]
    fn shape_tail_drops_the_fragment_of_a_partial_read() {
        assert_eq!(shape_tail(b"xxx\nlast", 8, true).as_deref(), Some("last"));
        assert_eq!(shape_tail(b"only", 8, true).as_deref(), Some("only"));
    }

    #[test]
    fn strip_ansi_drops_csi_and_osc() {
        assert_eq!(strip_ansi("\x1b]0;title\x07a\x1b[1;31mb\x1b[Kc"), "abc");
        assert_eq!(strip_ansi("\x1b]8;;http://x\x1b\\link"), "link");
    }

    #[test]
    fn only_task_output_files_are_followable_by_shape() {
        assert!(is_task_output(Path::new(
            "/tmp/claude-1000/-home-me-repo/0b1c/tasks/btcvgo7h4.output"
        )));
        assert!(!is_task_output(Path::new("/home/me/.ssh/id_ed25519")));
        assert!(!is_task_output(Path::new(
            "/tmp/claude-1000/x/tasks/notes.txt"
        )));
        assert!(!is_task_output(Path::new("/tmp/other/tasks/a.output")));
        assert!(!is_task_output(Path::new(
            "relative/claude-1/tasks/a.output"
        )));
    }

    #[test]
    fn arbitrary_files_are_refused() {
        assert!(tool_output_tail("/etc/passwd".into(), 10).is_err());
    }

    #[test]
    fn read_tail_reports_size_and_last_lines() {
        let dir = std::env::temp_dir().join(format!("mangouste-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.output");
        std::fs::write(&path, "one\ntwo\nthree\n").unwrap();
        let tail = read_tail(path.to_str().unwrap(), 2).expect("tail");
        assert_eq!(tail.text, "two\nthree");
        assert_eq!(tail.bytes, 14);
        assert!(tail.mtime_ms > 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
