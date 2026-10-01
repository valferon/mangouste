//! Live updates for the file tree.
//!
//! The tree re-read itself after its own writes and after a pull, and nothing
//! else: a file a session wrote, a `git checkout` in the terminal, a save from
//! another editor all sat invisible until someone hit Refresh.
//!
//! What is watched is exactly what the tree has listed, one level each, and not
//! the repo. A recursive watch on a repo means one inotify watch per directory
//! under it — `node_modules` and `target` included — to report on rows nobody
//! has expanded. The tree already knows which directories it is showing, so it
//! hands that set over and this keeps the watches in step with it.
//!
//! One watcher per window, since each window has its own tree, dropped with the
//! window.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify::event::{EventKind, ModifyKind};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{Emitter, Manager, Window};

pub const EVENT_TREE_CHANGED: &str = "tree://changed";

/// Short: this is a reaction to something the user is looking at. Long enough
/// that a `git checkout` touching a few hundred files arrives as one batch.
const TREE_DEBOUNCE: Duration = Duration::from_millis(100);

/// The longest a batch waits for quiet: a build writing into a watched folder
/// non-stop would otherwise hold every other change back until it finished.
const TREE_BATCH_MAX: Duration = Duration::from_millis(500);

struct TreeWatch {
    watcher: RecommendedWatcher,
    /// Shared with the event handler, which maps paths back to watched dirs.
    dirs: std::sync::Arc<Mutex<Watched>>,
}

/// Every spelling of a watched directory, mapped to the one the tree uses.
///
/// FSEvents reports resolved paths: on macOS a repo under `/var/...` changes as
/// `/private/var/...`, and any symlink on the way to a repo does the same. Both
/// the tree's spelling and the canonical one are keys, and events come back to
/// the tree in its own, or it would not recognise them as rows it holds.
type Watched = HashMap<PathBuf, PathBuf>;

#[derive(Default)]
pub struct TreeWatchState {
    windows: Mutex<HashMap<String, TreeWatch>>,
}

/// Whether an event can change what a directory lists.
///
/// The tree shows names and kinds only, so a write into a file is not news. A
/// session streaming into a log would otherwise re-list its directory every
/// debounce for as long as it ran.
fn changes_listing(kind: &EventKind) -> bool {
    match kind {
        EventKind::Create(_) | EventKind::Remove(_) => true,
        EventKind::Modify(ModifyKind::Name(_)) => true,
        EventKind::Modify(ModifyKind::Any) | EventKind::Any | EventKind::Other => true,
        EventKind::Modify(_) | EventKind::Access(_) => false,
    }
}

/// The watched directories whose listing a batch of events may have changed.
///
/// A path's parent lists it, so the parent re-reads. A path that is itself a
/// watched directory re-reads too: that is how its own removal reaches the
/// tree, which drops a directory whose listing fails.
fn affected_dirs<'a>(
    events: impl IntoIterator<Item = (&'a EventKind, &'a [PathBuf])>,
    watched: &Watched,
) -> BTreeSet<PathBuf> {
    let mut out = BTreeSet::new();
    for (kind, paths) in events {
        if !changes_listing(kind) {
            continue;
        }
        for path in paths {
            if let Some(dir) = watched.get(path) {
                out.insert(dir.clone());
            }
            if let Some(dir) = path.parent().and_then(|parent| watched.get(parent)) {
                out.insert(dir.clone());
            }
        }
    }
    out
}

fn start(window: &Window) -> Result<TreeWatch, String> {
    let target = window.clone();
    spawn(move |dirs| {
        let _ = target.emit_to(target.label(), EVENT_TREE_CHANGED, dirs);
    })
}

/// A watcher with nothing watched yet, reporting changed dirs to `on_change`.
///
/// Raw `notify` events batched by a quiet period, rather than
/// `notify-debouncer-full`: that one pairs a rename's two halves by file id,
/// and on macOS drops the half it cannot pair, so a file moved out of a folder
/// never told that folder. The tree has no use for the pairing, only for both
/// directories.
fn spawn(on_change: impl Fn(Vec<String>) + Send + 'static) -> Result<TreeWatch, String> {
    let dirs = std::sync::Arc::new(Mutex::new(Watched::new()));
    let watched = std::sync::Arc::clone(&dirs);
    let (tx, rx) = std::sync::mpsc::channel::<Event>();
    let watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        if let Ok(event) = result {
            let _ = tx.send(event);
        }
    })
    .map_err(|e| format!("tree watcher failed to start: {e}"))?;

    // Ends when the watcher is dropped: that drops the sender, and `recv` fails.
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch = vec![first];
            let deadline = std::time::Instant::now() + TREE_BATCH_MAX;
            while let Ok(next) = rx.recv_timeout(
                TREE_DEBOUNCE.min(deadline.saturating_duration_since(std::time::Instant::now())),
            ) {
                batch.push(next);
            }
            let changed = {
                let watched = watched.lock().unwrap_or_else(|e| e.into_inner());
                affected_dirs(
                    batch.iter().map(|e| (&e.kind, e.paths.as_slice())),
                    &watched,
                )
            };
            if !changed.is_empty() {
                on_change(
                    changed
                        .into_iter()
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect(),
                );
            }
        }
    });
    Ok(TreeWatch { watcher, dirs })
}

impl TreeWatch {
    /// Apply the difference between what is watched and `wanted`.
    fn sync(&mut self, wanted: HashSet<PathBuf>) {
        let mut current = self.dirs.lock().unwrap_or_else(|e| e.into_inner());
        let held: HashSet<PathBuf> = current.values().cloned().collect();
        for dir in held.difference(&wanted) {
            let _ = self.watcher.unwatch(dir);
            current.retain(|_, original| original != dir);
        }
        for dir in wanted {
            if held.contains(&dir) || !Path::new(&dir).is_dir() {
                continue;
            }
            if self
                .watcher
                .watch(&dir, RecursiveMode::NonRecursive)
                .is_ok()
            {
                if let Ok(canonical) = dir.canonicalize() {
                    current.insert(canonical, dir.clone());
                }
                current.insert(dir.clone(), dir);
            }
        }
    }
}

/// Make the watched set exactly `dirs` for the calling window.
///
/// Only the difference is applied: the tree calls this on every expand, and
/// re-adding a few hundred watches each time would be the cost this design is
/// meant to avoid. A directory that cannot be watched (gone, permissions) is
/// skipped rather than failing the rest.
#[tauri::command]
pub fn watch_tree(
    window: Window,
    state: tauri::State<'_, TreeWatchState>,
    dirs: Vec<String>,
) -> Result<(), String> {
    let mut windows = state.windows.lock().unwrap_or_else(|e| e.into_inner());
    let label = window.label().to_string();
    if dirs.is_empty() {
        windows.remove(&label);
        return Ok(());
    }
    if !windows.contains_key(&label) {
        windows.insert(label.clone(), start(&window)?);
    }
    let Some(watch) = windows.get_mut(&label) else {
        return Ok(());
    };

    watch.sync(dirs.into_iter().map(PathBuf::from).collect());
    Ok(())
}

/// Drop a closed window's watcher, and its inotify watches with it.
pub fn drop_window(app: &tauri::AppHandle, label: &str) {
    let state: tauri::State<'_, TreeWatchState> = app.state();
    let mut windows = state.windows.lock().unwrap_or_else(|e| e.into_inner());
    windows.remove(label);
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, DataChange, RemoveKind, RenameMode};

    fn set(paths: &[&str]) -> Watched {
        paths
            .iter()
            .map(|p| (PathBuf::from(p), PathBuf::from(p)))
            .collect()
    }

    fn run(events: &[(EventKind, Vec<PathBuf>)], watched: &[&str]) -> Vec<String> {
        affected_dirs(events.iter().map(|(k, p)| (k, p.as_slice())), &set(watched))
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn a_new_file_re_reads_its_parent() {
        let events = [(
            EventKind::Create(CreateKind::File),
            vec!["/r/src/a.ts".into()],
        )];
        assert_eq!(run(&events, &["/r", "/r/src"]), ["/r/src"]);
    }

    #[test]
    fn a_rename_re_reads_both_sides() {
        let events = [(
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            vec!["/r/src/a.ts".into(), "/r/lib/a.ts".into()],
        )];
        assert_eq!(run(&events, &["/r/src", "/r/lib"]), ["/r/lib", "/r/src"]);
    }

    #[test]
    fn a_removed_watched_dir_re_reads_itself_and_its_parent() {
        let events = [(EventKind::Remove(RemoveKind::Folder), vec!["/r/src".into()])];
        assert_eq!(run(&events, &["/r", "/r/src"]), ["/r", "/r/src"]);
    }

    #[test]
    fn writes_into_a_file_are_not_news() {
        let events = [
            (
                EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                vec!["/r/log.txt".into()],
            ),
            (
                EventKind::Access(AccessKind::Read),
                vec!["/r/log.txt".into()],
            ),
        ];
        assert!(run(&events, &["/r"]).is_empty());
    }

    /// Collects what a real watcher reports until `want` has all shown up.
    fn wait_for(rx: &std::sync::mpsc::Receiver<Vec<String>>, want: &[&Path]) -> BTreeSet<String> {
        let mut seen = BTreeSet::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while want.iter().any(|w| !seen.contains(&*w.to_string_lossy())) {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match rx.recv_timeout(left) {
                Ok(dirs) => seen.extend(dirs),
                Err(_) => break,
            }
        }
        seen
    }

    #[test]
    fn a_real_watcher_reports_create_rename_and_delete() {
        let root = std::env::temp_dir().join(format!("mg-treewatch-{}", std::process::id()));
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watch = spawn(move |dirs| {
            let _ = tx.send(dirs);
        })
        .unwrap();
        watch.sync([root.clone(), sub.clone()].into_iter().collect());

        std::fs::write(sub.join("a.txt"), "x").unwrap();
        assert!(wait_for(&rx, &[&sub]).contains(&*sub.to_string_lossy()));

        std::fs::rename(sub.join("a.txt"), root.join("a.txt")).unwrap();
        let seen = wait_for(&rx, &[&sub, &root]);
        assert!(seen.contains(&*sub.to_string_lossy()), "{seen:?}");
        assert!(seen.contains(&*root.to_string_lossy()), "{seen:?}");

        // Unwatched once dropped from the set: a write there is not reported.
        watch.sync([root.clone()].into_iter().collect());
        while rx.try_recv().is_ok() {}
        std::fs::write(sub.join("b.txt"), "x").unwrap();
        std::fs::remove_file(root.join("a.txt")).unwrap();
        let seen = wait_for(&rx, &[&root]);
        assert!(!seen.contains(&*sub.to_string_lossy()), "{seen:?}");

        drop(watch);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_resolved_path_comes_back_in_the_trees_spelling() {
        let watched: Watched = [
            (PathBuf::from("/var/r"), PathBuf::from("/var/r")),
            (PathBuf::from("/private/var/r"), PathBuf::from("/var/r")),
        ]
        .into_iter()
        .collect();
        let events = [(
            EventKind::Create(CreateKind::File),
            vec![PathBuf::from("/private/var/r/a.ts")],
        )];
        let got = affected_dirs(events.iter().map(|(k, p)| (k, p.as_slice())), &watched);
        assert_eq!(
            got.into_iter().collect::<Vec<_>>(),
            [PathBuf::from("/var/r")]
        );
    }

    #[test]
    fn unwatched_parents_are_ignored() {
        let events = [(
            EventKind::Create(CreateKind::File),
            vec!["/r/deep/x".into()],
        )];
        assert!(run(&events, &["/r"]).is_empty());
    }
}
