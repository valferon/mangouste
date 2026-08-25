//! Repo discovery and lazy file-tree listing for the left sidebar.

use std::io::Read;
use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub name: String,
    pub path: String,
    pub is_git: bool,
}

fn modified_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// List one directory level. Directories sort first, then case-insensitive by name.
///
/// `respect_gitignore` routes the listing through the `ignore` crate so the tree
/// hides the same files git does; `show_hidden` still surfaces dotfiles.
///
/// The walking commands here are all `async`: a cold-cache or network mount
/// walk blocks long enough to freeze the UI if run on the main thread.
#[tauri::command(async)]
pub fn list_dir(
    path: String,
    respect_gitignore: Option<bool>,
    show_hidden: Option<bool>,
) -> Result<Vec<DirEntryInfo>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let respect_gitignore = respect_gitignore.unwrap_or(true);
    let show_hidden = show_hidden.unwrap_or(true);

    let mut entries = Vec::new();
    let walker = WalkBuilder::new(&root)
        .max_depth(Some(1))
        .hidden(!show_hidden)
        .git_ignore(respect_gitignore)
        .git_global(respect_gitignore)
        .git_exclude(respect_gitignore)
        .parents(respect_gitignore)
        .follow_links(false)
        .build();

    for entry in walker.flatten() {
        // Depth 0 is the directory being listed.
        if entry.depth() == 0 {
            continue;
        }
        let entry_path = entry.path();
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        // `follow_links(false)` hands back the link's own metadata, so a symlink
        // has to be resolved before it can be classified: without this a
        // symlinked directory is emitted as a file, and its size and mtime are
        // the link's rather than the target's.
        // A dangling link keeps the link's own metadata and stays in the tree:
        // "this file will not open" is a better answer than a row that silently
        // is not there, and repos carry such links routinely (`node_modules/.bin`,
        // links to sibling checkouts).
        let metadata = if metadata.file_type().is_symlink() {
            std::fs::metadata(entry_path).unwrap_or(metadata)
        } else {
            metadata
        };
        // Skip anything that is neither a regular file nor a directory. The tree
        // makes every non-directory row clickable (`FileTree.tsx` → `openFile` →
        // `read_text_file`), and classifying by `is_dir()` alone made a FIFO,
        // socket or device look like an ordinary file — a click that can only
        // fail, and for a FIFO one that used to block in `open(2)` forever.
        // A link whose target could not be resolved keeps `is_symlink()` here,
        // so it survives the filter and is listed as a file.
        let file_type = metadata.file_type();
        if !file_type.is_file() && !file_type.is_dir() && !file_type.is_symlink() {
            continue;
        }
        entries.push(DirEntryInfo {
            name: entry_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: entry_path.to_string_lossy().into_owned(),
            is_dir: file_type.is_dir(),
            size: metadata.len(),
            modified_ms: modified_ms(&metadata),
        });
    }

    // Cached key: `to_lowercase` allocates, and a comparator would re-run it
    // O(n log n) times.
    entries.sort_by_cached_key(|e| (std::cmp::Reverse(e.is_dir), e.name.to_lowercase()));
    Ok(entries)
}

/// One level of subdirectories under `root`, flagged by whether they are git repos.
///
/// This backs the repo switcher, which is what replaces one-VSCode-window-per-repo.
#[tauri::command(async)]
pub fn discover_repos(root: String) -> Result<Vec<RepoInfo>, String> {
    let root = PathBuf::from(&root);
    let mut repos = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        repos.push(RepoInfo {
            is_git: path.join(".git").exists(),
            name,
            path: path.to_string_lossy().into_owned(),
        });
    }
    repos.sort_by_cached_key(|r| r.name.to_lowercase());
    Ok(repos)
}

/// Substring file search for quick-open, ranked so shorter paths win ties.
#[tauri::command(async)]
pub fn search_files(
    root: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<DirEntryInfo>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let needle = query.to_lowercase();
    // Clamped: the frontend owns this value, and `usize::MAX` would overflow
    // the walk cap below.
    let limit = limit.unwrap_or(200).min(1000);
    let mut hits: Vec<DirEntryInfo> = Vec::new();

    for entry in WalkBuilder::new(&root_path)
        .hidden(true)
        .git_ignore(true)
        .follow_links(false)
        .build()
        .flatten()
    {
        if entry.depth() == 0 || entry.file_type().is_none_or(|t| t.is_dir()) {
            continue;
        }
        let path = entry.path();
        let relative = path.strip_prefix(&root_path).unwrap_or(path);
        let relative_str = relative.to_string_lossy();
        if !needle.is_empty() && !relative_str.to_lowercase().contains(&needle) {
            continue;
        }
        let metadata = entry.metadata().ok();
        hits.push(DirEntryInfo {
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: path.to_string_lossy().into_owned(),
            is_dir: false,
            size: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
            modified_ms: metadata.as_ref().map(modified_ms).unwrap_or(0),
        });
        // Cap the walk generously, then rank and trim below.
        if hits.len() >= limit.saturating_mul(5) {
            break;
        }
    }

    hits.sort_by_key(|h| h.path.len());
    hits.truncate(limit);
    Ok(hits)
}

/// A file's text together with the mtime it was read at.
///
/// The editor keeps the mtime and hands it back on save, so a file that claude
/// rewrote while the tab sat open is detected instead of silently overwritten.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub content: String,
    pub modified_ms: u64,
}

/// Shared body of `read_text_file` and `read_text_file_meta`, and the one reader
/// the find-and-replace sweep opens files through: what the editor refuses to
/// show — oversized, binary, not a regular file — is exactly what a repo-wide
/// search has no business reading either.
pub(crate) fn read_text(path: &Path, max_bytes: Option<u64>) -> Result<FileText, String> {
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let max_bytes = max_bytes.unwrap_or(READ_BUDGET_BYTES);
    // `len()` is not a size guard on its own, because only regular files have a
    // meaningful one. A FIFO reports 0 and then parks in `open(2)` until a writer
    // shows up — the tab hangs on "Loading…" and a worker thread is gone for
    // good — and a character device like /dev/zero reports 0 and streams until
    // the allocator aborts the process. Reject those before opening anything.
    if !metadata.file_type().is_file() {
        return Err("not a regular file".to_string());
    }
    if metadata.len() > max_bytes {
        return Err(format!("file too large: {} bytes", metadata.len()));
    }
    // Read through `take` rather than `fs::read`: the stat above is a snapshot,
    // so a file that grows between it and the read would otherwise come in
    // whole. One byte past the cap is enough to notice the overrun.
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("file too large: over {max_bytes} bytes"));
    }
    if bytes.contains(&0) {
        return Err("binary file".to_string());
    }
    Ok(FileText {
        content: String::from_utf8_lossy(&bytes).into_owned(),
        modified_ms: modified_ms(&metadata),
    })
}

/// Read a file as text, refusing anything too large, binary, or not a regular
/// file to render.
#[tauri::command(async)]
pub fn read_text_file(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    read_text(Path::new(&path), max_bytes).map(|file| file.content)
}

/// `read_text_file` plus the mtime, which is what the editor opens through: the
/// value it must hand back to `write_text_file` has to come from the same stat
/// as the bytes, or a rewrite landing between the two reads goes unnoticed.
#[tauri::command(async)]
pub fn read_text_file_meta(path: String, max_bytes: Option<u64>) -> Result<FileText, String> {
    read_text(Path::new(&path), max_bytes)
}

/// Largest file the viewer will read, and so the largest one it can save back.
const READ_BUDGET_BYTES: u64 = 2 * 1024 * 1024;

/// Makes each in-flight save's scratch file unique, so two tabs saving into the
/// same directory at once cannot write through one another's temp path.
static SAVE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Save text over an existing file, returning the new mtime.
///
/// `expected_modified_ms` is optimistic locking, and the reason this is not a
/// plain `fs::write`: claude edits the same files the editor has open, so a save
/// that cannot prove it started from what is on disk is refused and the caller
/// is told to reload rather than allowed to drop the other writer's work. Pass
/// `None` to force the write through — what the "overwrite anyway" path does.
#[tauri::command(async)]
pub fn write_text_file(
    path: String,
    content: String,
    expected_modified_ms: Option<u64>,
) -> Result<u64, String> {
    save_text(&path, &content, expected_modified_ms)
}

/// Body of `write_text_file`, shared with the find-and-replace writer.
///
/// Every guarantee a save makes lives here and nowhere else: the mtime check,
/// the link resolution, the carried mode, the temp-file-and-rename. A second
/// writer with its own copy of this would be a second chance to get one of them
/// wrong, and the one that matters most — refusing a stale write — is invisible
/// when it is missing.
pub(crate) fn save_text(
    path: &str,
    content: &str,
    expected_modified_ms: Option<u64>,
) -> Result<u64, String> {
    if content.len() as u64 > READ_BUDGET_BYTES {
        return Err(format!("too large to save: {} bytes", content.len()));
    }
    // Resolve links before touching anything: `metadata` follows a symlink, so
    // without this the rename below would replace the *link* with a regular
    // file and lose it. Also rejects a path whose parent no longer exists.
    let target = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let metadata = std::fs::metadata(&target).map_err(|e| e.to_string())?;
    // Same reasoning as the read guard: a device or FIFO would be written
    // *through*, and a directory cannot be replaced by a rename.
    if !metadata.file_type().is_file() {
        return Err("not a regular file".to_string());
    }
    if let Some(expected) = expected_modified_ms {
        let actual = modified_ms(&metadata);
        if actual != expected {
            return Err(format!("changed on disk since it was opened (STALE:{actual})"));
        }
    }

    let parent = target
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| "path has no file name".to_string())?;
    let serial = SAVE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // Written beside the target, not in /tmp: the rename that publishes it is
    // only atomic within one filesystem, and a crash mid-write has to leave the
    // original intact rather than truncated.
    let temporary = parent.join(format!(".{name}.mangouste-{serial}.tmp"));

    let write = std::fs::write(&temporary, content.as_bytes())
        .map_err(|e| e.to_string())
        // A fresh temp file is 0644, which would quietly strip the executable
        // bit off a script; carry the original mode across before publishing.
        .and_then(|()| {
            std::fs::set_permissions(&temporary, metadata.permissions()).map_err(|e| e.to_string())
        })
        .and_then(|()| std::fs::rename(&temporary, &target).map_err(|e| e.to_string()));
    if let Err(e) = write {
        // Leaving a dotfile behind in the user's repo is its own bug.
        let _ = std::fs::remove_file(&temporary);
        return Err(e);
    }

    Ok(std::fs::metadata(&target)
        .map(|m| modified_ms(&m))
        .unwrap_or(0))
}

/// Home directory, so the frontend can default the repo root without guessing.
#[tauri::command]
pub fn home_dir() -> Option<String> {
    dirs::home_dir().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Per-test scratch directory, removed and recreated so a rerun starts clean.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mangouste-workspace-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// The whole reason saving is not `fs::write`: claude edits the same files
    /// the editor has open, so a save carrying a stale mtime has to be refused.
    #[test]
    fn write_refuses_a_stale_mtime() {
        let dir = scratch("stale");
        let file = dir.join("a.txt");
        std::fs::write(&file, "original\n").unwrap();
        let path = file.to_string_lossy().into_owned();
        let opened = read_text(&file, None).unwrap();

        let refused = write_text_file(path.clone(), "mine\n".into(), Some(opened.modified_ms + 1));
        assert!(refused.is_err(), "a mismatched mtime must not write");
        assert!(refused.unwrap_err().contains("STALE:"), "the frontend keys off this marker");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "original\n");

        // The mtime it was actually read at goes through.
        write_text_file(path.clone(), "mine\n".into(), Some(opened.modified_ms)).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "mine\n");

        // And `None` is the deliberate overwrite the conflict banner offers.
        write_text_file(path, "forced\n".into(), None).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "forced\n");
    }

    /// The save publishes through a rename, which without resolving the link
    /// first would replace the link itself with a regular file.
    #[test]
    #[cfg(unix)]
    fn write_through_a_symlink_keeps_the_link() {
        let dir = scratch("symlink");
        let target = dir.join("target.txt");
        let link = dir.join("link.txt");
        std::fs::write(&target, "before\n").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        write_text_file(link.to_string_lossy().into_owned(), "after\n".into(), None).unwrap();

        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "after\n");
    }

    /// A fresh temp file is 0644, so publishing one over a script would quietly
    /// make it unrunnable.
    #[test]
    #[cfg(unix)]
    fn write_keeps_the_executable_bit() {
        use std::os::unix::fs::PermissionsExt;

        let dir = scratch("mode");
        let file = dir.join("run.sh");
        std::fs::write(&file, "#!/bin/sh\ntrue\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();

        write_text_file(file.to_string_lossy().into_owned(), "#!/bin/sh\nfalse\n".into(), None)
            .unwrap();

        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755, "mode was not carried across the rename");
        // No scratch file left behind in the user's tree.
        let strays: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("mangouste-"))
            .collect();
        assert!(strays.is_empty(), "temp file survived the save");
    }

    /// Only regular files: a directory cannot be replaced by the rename, and a
    /// FIFO or device would be written *through*.
    #[test]
    fn write_refuses_a_directory() {
        let dir = scratch("dir");
        assert!(write_text_file(dir.to_string_lossy().into_owned(), "x".into(), None).is_err());
    }
}
