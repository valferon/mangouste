//! Mutating file-tree operations: create, rename, delete, copy.
//!
//! Split from `workspace.rs`, which reads the tree and writes *into* files that
//! already exist. Everything here changes the shape of the tree itself, and
//! every one of these commands is destructive in a way a read never is, so the
//! guards they share ([`guard`], [`guard_removable`]) live in one place with the
//! reasoning attached rather than being restated per command.
//!
//! Like the walking commands next door these are all `async`: a recursive copy
//! or a `remove_dir_all` over a large tree blocks long enough to freeze the UI
//! if it runs on the main thread.

use std::path::{Path, PathBuf};

/// Sanity check every mutating command starts with.
///
/// The frontend only ever passes paths it read out of a directory listing, so a
/// relative path or a `..` component means something built a path by string
/// concatenation and got it wrong. Refusing is cheaper than finding out which
/// directory above the repo it landed in.
fn guard(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("path must be absolute".to_string());
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("path must not contain ..".to_string());
    }
    Ok(path)
}

/// [`guard`], plus the two paths nothing in this app may ever remove or move.
///
/// A delete here is permanent — there is no trash — so the blast radius of one
/// bad path is the whole home directory. The confirm in front of the menu item
/// is a prompt the user can misread; this is the one they cannot.
fn guard_removable(path: &str) -> Result<PathBuf, String> {
    let path = guard(path)?;
    if path.parent().is_none() {
        return Err("refusing to touch the filesystem root".to_string());
    }
    let resolved = resolve_parent(&path);
    if resolved.parent().is_none() {
        return Err("refusing to touch the filesystem root".to_string());
    }
    let home = dirs::home_dir().map(|home| resolve_parent(&home));
    if home.is_some_and(|home| home == resolved) {
        return Err("refusing to touch the home directory".to_string());
    }
    Ok(path)
}

/// `path` with its *parent* resolved, and its own last segment left alone.
///
/// A plain `canonicalize` would be wrong twice over: it resolves the entry
/// itself, so deleting a symlink that happens to point at the home directory
/// would be refused, and it fails outright on a path that is not there. What
/// the guard above actually needs is "which directory does this really name",
/// which is the parent — enough to catch a bind mount or a linked parent
/// spelling the same place a different way. Falls back to the path as written
/// when the parent cannot be read; the guard is then no weaker than a plain
/// string compare.
fn resolve_parent(path: &Path) -> PathBuf {
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => std::fs::canonicalize(parent)
            .map(|parent| parent.join(name))
            .unwrap_or_else(|_| path.to_path_buf()),
        _ => path.to_path_buf(),
    }
}

/// Whether anything at all sits at `path`, link or not.
///
/// `Path::exists` follows symlinks and so calls a broken one absent, which
/// would let a create or a rename silently replace it.
fn occupied(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// The parent a new entry needs, created if it is missing.
///
/// New entries are named by typing a path, not just a name, so `a/b/c.ts` in a
/// directory that holds no `a` is an ordinary thing to ask for.
fn prepare_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())
}

/// Create an empty file, failing if anything already holds the name.
///
/// `create_new` makes the existence check and the creation one syscall, so two
/// windows racing the same name cannot both believe they made it.
#[tauri::command(async)]
pub fn create_file(path: String) -> Result<(), String> {
    let path = guard(&path)?;
    prepare_parent(&path)?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map(|_| ())
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => "already exists".to_string(),
            _ => e.to_string(),
        })
}

/// Create a directory, failing if anything already holds the name.
///
/// The parents come from `create_dir_all` but the leaf itself deliberately does
/// not: `create_dir_all` on the whole path would succeed on a directory that
/// was already there, and "New Folder" quietly selecting someone else's folder
/// is how a later paste lands in the wrong place.
#[tauri::command(async)]
pub fn create_dir(path: String) -> Result<(), String> {
    let path = guard(&path)?;
    prepare_parent(&path)?;
    std::fs::create_dir(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => "already exists".to_string(),
        _ => e.to_string(),
    })
}

/// Rename or move an entry, refusing to overwrite whatever is at the target.
///
/// The refusal is a check and not a flag because `fs::rename` on unix replaces
/// the destination without a word. That leaves a race — the target could appear
/// between the check and the rename — which is the trade for not reaching past
/// `std` to `renameat2`; losing that race needs another writer to create the
/// exact name in the microseconds between the two calls.
#[tauri::command(async)]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    let from = guard_removable(&from)?;
    let to = guard(&to)?;
    if from == to {
        return Ok(());
    }
    if !occupied(&from) {
        return Err("source is gone".to_string());
    }
    if occupied(&to) {
        return Err("already exists".to_string());
    }
    // A move into the tree's own subtree would either fail obscurely (EINVAL)
    // or, for the copy fallback below, recurse forever.
    if to.starts_with(&from) {
        return Err("cannot move a directory into itself".to_string());
    }
    prepare_parent(&to)?;

    match std::fs::rename(&from, &to) {
        Ok(()) => Ok(()),
        // Dragging a file onto another mount — a different disk, a network
        // share, `/tmp` on its own filesystem — is EXDEV, and a plain rename
        // can never satisfy it. Copy and remove is what every file manager
        // falls back to, and it is only reached on failure so the common
        // same-filesystem move stays atomic.
        Err(e) if is_cross_device(&e) => {
            if let Err(failed) = copy_tree(&from, &to) {
                // A half-written tree at the target is worse than no tree: the
                // retry would hit "already exists" and the user was never told
                // there was anything to clean up.
                let _ = remove(&to);
                return Err(failed);
            }
            remove(&from).map_err(|e| {
                // Deliberately not "the original is still there": a
                // `remove_dir_all` that fails partway has already taken some of
                // it, and the user needs to look rather than assume.
                format!(
                    "copied to {}, but removing the original failed: {e}",
                    to.display()
                )
            })
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Whether a failed rename failed for spanning two filesystems.
///
/// Matched on the raw code because `ErrorKind::CrossesDevices` is stable only
/// since 1.83 and this crate builds back to 1.77, where the kind is still
/// `Uncategorized`. The code is per-platform, and 18 on Windows means something
/// else entirely, so each one is named rather than shared.
#[cfg(unix)]
fn is_cross_device(e: &std::io::Error) -> bool {
    e.raw_os_error() == Some(18) // EXDEV
}

#[cfg(windows)]
fn is_cross_device(e: &std::io::Error) -> bool {
    e.raw_os_error() == Some(17) // ERROR_NOT_SAME_DEVICE
}

#[cfg(not(any(unix, windows)))]
fn is_cross_device(_: &std::io::Error) -> bool {
    false
}

/// Delete an entry, recursively for a directory.
///
/// Permanent, by the app's own choice: there is no trash and no undo, so the
/// caller is expected to have confirmed with the user first.
#[tauri::command(async)]
pub fn delete_path(path: String) -> Result<(), String> {
    let path = guard_removable(&path)?;
    if !occupied(&path) {
        return Err("already gone".to_string());
    }
    remove(&path).map_err(|e| e.to_string())
}

/// Body of the delete, shared with the cross-device move.
///
/// Reads the metadata *without* following links: `remove_dir_all` through a
/// symlink to a directory would empty the directory it points at, which for a
/// link into a shared folder is somebody else's data.
fn remove(path: &Path) -> std::io::Result<()> {
    let kind = std::fs::symlink_metadata(path)?.file_type();
    if kind.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

/// Copy an entry, refusing to overwrite whatever is at the target.
///
/// Backs the tree's paste. Returns nothing the caller does not already know;
/// the target name is theirs.
#[tauri::command(async)]
pub fn copy_path(from: String, to: String) -> Result<(), String> {
    let from = guard(&from)?;
    let to = guard(&to)?;
    if !occupied(&from) {
        return Err("source is gone".to_string());
    }
    if occupied(&to) {
        return Err("already exists".to_string());
    }
    if to.starts_with(&from) {
        return Err("cannot copy a directory into itself".to_string());
    }
    prepare_parent(&to)?;
    copy_tree(&from, &to)
}

/// Copy an entry beside itself under a free name, returning the path made.
///
/// The name is picked here rather than in the frontend because picking it means
/// testing what exists, and a caller that tests and then copies can lose the
/// race to another window doing the same. `copy_tree` still refuses an occupied
/// target, so the worst case is an error instead of a clobbered file.
#[tauri::command(async)]
pub fn duplicate_path(path: String) -> Result<String, String> {
    let path = guard(&path)?;
    if !occupied(&path) {
        return Err("source is gone".to_string());
    }
    let target = free_copy_name(&path)?;
    copy_tree(&path, &target)?;
    Ok(target.to_string_lossy().into_owned())
}

/// `notes.md` → `notes copy.md` → `notes copy 2.md`, first one free.
///
/// The suffix goes before the extension so the duplicate stays the same kind of
/// file: `notes.md copy` opens in nothing, and for `.sh` it would lose the
/// shebang's only hint to an editor.
fn free_copy_name(path: &Path) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| "path has no file name".to_string())?;
    // Split on the *last* dot, and never on a leading one: `.gitignore` is a
    // name with no extension, not an extension with no name.
    let (stem, extension) = match name.rfind('.') {
        Some(at) if at > 0 => (&name[..at], &name[at..]),
        _ => (name.as_str(), ""),
    };

    for attempt in 1..1000 {
        let suffix = if attempt == 1 {
            " copy".to_string()
        } else {
            format!(" copy {attempt}")
        };
        let candidate = parent.join(format!("{stem}{suffix}{extension}"));
        if !occupied(&candidate) {
            return Ok(candidate);
        }
    }
    Err("too many copies of that name".to_string())
}

/// Deepest directory nesting a copy will walk.
///
/// Symlink cycles are already defused (links are relinked, never followed), so
/// what is left is honest depth. `copy_tree` recurses once per level, and a
/// pathological tree would take the worker thread's stack down with it; a repo
/// nested this far has other problems.
const MAX_COPY_DEPTH: usize = 64;

/// Recursive copy: directories by walking, files by `fs::copy`, links relinked.
///
/// `fs::copy` carries the mode across, which matters for the same reason the
/// save next door restores it — a duplicated script that lost its executable
/// bit looks fine in the tree and fails when it is run.
///
/// Assumes `to` is free. Every caller checks that with [`occupied`] first, and
/// the check is theirs to keep: `fs::copy` below would overwrite a file without
/// a word, the same way `fs::rename` would.
fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    copy_tree_at(from, to, 0)
}

fn copy_tree_at(from: &Path, to: &Path, depth: usize) -> Result<(), String> {
    if depth > MAX_COPY_DEPTH {
        return Err(format!("nested deeper than {MAX_COPY_DEPTH} directories"));
    }
    let kind = std::fs::symlink_metadata(from)
        .map_err(|e| e.to_string())?
        .file_type();

    if kind.is_symlink() {
        // Copied as a link, not as its contents: following it would turn one
        // entry into a full second copy of whatever it points at, and a link
        // pointing back up its own tree would never terminate.
        #[cfg(unix)]
        {
            let target = std::fs::read_link(from).map_err(|e| e.to_string())?;
            return std::os::unix::fs::symlink(target, to).map_err(|e| e.to_string());
        }
        #[cfg(not(unix))]
        return Err("cannot copy a symlink on this platform".to_string());
    }

    if !kind.is_dir() {
        // Also the guard against copying a FIFO or a device node, which
        // `fs::copy` would read from — blocking forever on an empty pipe.
        if !kind.is_file() {
            return Err("not a regular file".to_string());
        }
        std::fs::copy(from, to)
            .map(|_| ())
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    std::fs::create_dir(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        copy_tree_at(&entry.path(), &to.join(entry.file_name()), depth + 1)?;
    }
    // Carried last, not at creation: `fs::create_dir` takes the umask rather
    // than the source's mode, and restoring a mode like 0500 before the
    // children are written would lock the copy out of its own directory.
    #[cfg(unix)]
    if let Ok(source) = std::fs::metadata(from) {
        std::fs::set_permissions(to, source.permissions()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Per-test scratch directory, removed and recreated so a rerun starts clean.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mangouste-fileops-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn text(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    fn name(path: &Path) -> String {
        path.file_name().unwrap().to_string_lossy().into_owned()
    }

    /// Typing a path and not just a name is the normal way to use "New File".
    #[test]
    fn create_makes_missing_parents() {
        let dir = scratch("create-nested");
        let file = dir.join("a/b/c.ts");

        create_file(file.to_string_lossy().into_owned()).unwrap();

        assert!(file.is_file());
        assert_eq!(text(&file), "");
    }

    /// Both creates have to refuse an occupied name, or "New File" over an
    /// existing one is a silent truncate.
    #[test]
    fn create_refuses_an_occupied_name() {
        let dir = scratch("create-occupied");
        let file = dir.join("a.txt");
        std::fs::write(&file, "keep\n").unwrap();

        let refused = create_file(file.to_string_lossy().into_owned());
        assert_eq!(refused.unwrap_err(), "already exists");
        assert_eq!(text(&file), "keep\n", "the existing file was truncated");

        let existing = dir.join("sub");
        std::fs::create_dir(&existing).unwrap();
        assert_eq!(
            create_dir(existing.to_string_lossy().into_owned()).unwrap_err(),
            "already exists",
        );
    }

    /// `fs::rename` replaces the destination without a word, so the refusal is
    /// the only thing standing between a drag and someone else's file.
    #[test]
    fn rename_refuses_to_overwrite() {
        let dir = scratch("rename-overwrite");
        let from = dir.join("from.txt");
        let to = dir.join("to.txt");
        std::fs::write(&from, "moving\n").unwrap();
        std::fs::write(&to, "keep\n").unwrap();

        let refused = rename_path(
            from.to_string_lossy().into_owned(),
            to.to_string_lossy().into_owned(),
        );

        assert_eq!(refused.unwrap_err(), "already exists");
        assert_eq!(text(&to), "keep\n");
        assert!(from.is_file(), "the source was moved anyway");
    }

    /// Dropping a directory onto a row inside itself.
    #[test]
    fn rename_refuses_a_move_into_itself() {
        let dir = scratch("rename-into-itself");
        let tree = dir.join("tree");
        std::fs::create_dir_all(tree.join("inner")).unwrap();

        let refused = rename_path(
            tree.to_string_lossy().into_owned(),
            tree.join("inner/tree").to_string_lossy().into_owned(),
        );

        assert!(
            refused.is_err(),
            "a move into its own subtree must be refused"
        );
        assert!(tree.join("inner").is_dir());
    }

    /// A move is also how a rename crosses directories, and the target's parent
    /// may not exist yet when the name was typed rather than dragged.
    #[test]
    fn rename_moves_across_directories() {
        let dir = scratch("rename-move");
        let from = dir.join("a.txt");
        std::fs::write(&from, "body\n").unwrap();
        let to = dir.join("nested/deeper/b.txt");

        rename_path(
            from.to_string_lossy().into_owned(),
            to.to_string_lossy().into_owned(),
        )
        .unwrap();

        assert!(!occupied(&from));
        assert_eq!(text(&to), "body\n");
    }

    /// The two paths a bad join could reach, and the reason the check is here
    /// and not only behind the confirm dialog.
    #[test]
    fn nothing_removable_reaches_the_root_or_home() {
        assert!(delete_path("/".into()).is_err());
        assert!(rename_path("/".into(), "/moved".into()).is_err());
        if let Some(home) = dirs::home_dir() {
            let path = home.to_string_lossy().into_owned();
            assert!(delete_path(path.clone()).is_err());
            assert!(rename_path(path, "/tmp/mangouste-home".into()).is_err());
        }
        // Relative and `..` paths mean a caller built the path wrong.
        assert!(delete_path("relative/path".into()).is_err());
        assert!(delete_path("/tmp/../etc/passwd".into()).is_err());
    }

    /// `remove_dir_all` down a link would empty the directory it points at.
    #[test]
    #[cfg(unix)]
    fn delete_of_a_link_leaves_its_target_alone() {
        let dir = scratch("delete-link");
        let target = dir.join("real");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep.txt"), "keep\n").unwrap();
        let link = dir.join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        delete_path(link.to_string_lossy().into_owned()).unwrap();

        assert!(!occupied(&link));
        assert_eq!(text(&target.join("keep.txt")), "keep\n");
    }

    #[test]
    fn delete_removes_a_whole_tree() {
        let dir = scratch("delete-tree");
        let tree = dir.join("tree");
        std::fs::create_dir_all(tree.join("a/b")).unwrap();
        std::fs::write(tree.join("a/b/c.txt"), "x\n").unwrap();

        delete_path(tree.to_string_lossy().into_owned()).unwrap();

        assert!(!occupied(&tree));
        assert!(dir.is_dir(), "only the target goes");
    }

    /// The suffix goes before the extension so the copy is still the same kind
    /// of file, and the second duplicate has to find a name of its own.
    #[test]
    fn duplicate_names_keep_the_extension() {
        let dir = scratch("duplicate-names");
        let file = dir.join("notes.md");
        std::fs::write(&file, "body\n").unwrap();
        let path = file.to_string_lossy().into_owned();

        let first = duplicate_path(path.clone()).unwrap();
        assert_eq!(name(Path::new(&first)), "notes copy.md");
        assert_eq!(text(Path::new(&first)), "body\n");

        let second = duplicate_path(path).unwrap();
        assert_eq!(name(Path::new(&second)), "notes copy 2.md");

        // A dotfile is a name without an extension, not the other way round.
        let dotfile = dir.join(".gitignore");
        std::fs::write(&dotfile, "target\n").unwrap();
        let copied = duplicate_path(dotfile.to_string_lossy().into_owned()).unwrap();
        assert_eq!(name(Path::new(&copied)), ".gitignore copy");
    }

    #[test]
    fn duplicate_copies_a_directory() {
        let dir = scratch("duplicate-dir");
        let tree = dir.join("tree");
        std::fs::create_dir_all(tree.join("a")).unwrap();
        std::fs::write(tree.join("a/x.txt"), "x\n").unwrap();

        let copied = duplicate_path(tree.to_string_lossy().into_owned()).unwrap();

        assert_eq!(name(Path::new(&copied)), "tree copy");
        assert_eq!(text(&Path::new(&copied).join("a/x.txt")), "x\n");
        assert_eq!(text(&tree.join("a/x.txt")), "x\n", "the original moved");
    }

    /// Same reason the save next door restores the mode: a duplicated script
    /// that lost its executable bit looks fine and fails when it is run.
    #[test]
    #[cfg(unix)]
    fn copy_keeps_the_executable_bit() {
        use std::os::unix::fs::PermissionsExt;

        let dir = scratch("copy-mode");
        let file = dir.join("run.sh");
        std::fs::write(&file, "#!/bin/sh\ntrue\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        let to = dir.join("copied.sh");

        copy_path(
            file.to_string_lossy().into_owned(),
            to.to_string_lossy().into_owned(),
        )
        .unwrap();

        assert_eq!(
            std::fs::metadata(&to).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    /// Following the link instead would copy everything it points at, and a
    /// link back up its own tree would never terminate.
    #[test]
    #[cfg(unix)]
    fn copy_relinks_a_symlink() {
        let dir = scratch("copy-link");
        let target = dir.join("target.txt");
        std::fs::write(&target, "body\n").unwrap();
        let link = dir.join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let to = dir.join("copied.txt");

        copy_path(
            link.to_string_lossy().into_owned(),
            to.to_string_lossy().into_owned(),
        )
        .unwrap();

        assert!(std::fs::symlink_metadata(&to)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_link(&to).unwrap(), target);
    }

    /// The same guard `rename_path` has, on the path that does not move.
    #[test]
    fn copy_refuses_a_copy_into_itself() {
        let dir = scratch("copy-into-itself");
        let tree = dir.join("tree");
        std::fs::create_dir_all(tree.join("inner")).unwrap();

        let refused = copy_path(
            tree.to_string_lossy().into_owned(),
            tree.join("inner/tree").to_string_lossy().into_owned(),
        );

        assert!(
            refused.is_err(),
            "a copy into its own subtree must be refused"
        );
    }

    /// `create_dir` takes the umask, not the source's mode, so a directory
    /// copied out of a 0700 tree would come back world-readable.
    #[test]
    #[cfg(unix)]
    fn copy_keeps_directory_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = scratch("copy-dir-mode");
        let tree = dir.join("private");
        std::fs::create_dir(&tree).unwrap();
        std::fs::write(tree.join("secret.txt"), "shh\n").unwrap();
        std::fs::set_permissions(&tree, std::fs::Permissions::from_mode(0o700)).unwrap();
        let to = dir.join("copied");

        copy_path(
            tree.to_string_lossy().into_owned(),
            to.to_string_lossy().into_owned(),
        )
        .unwrap();

        assert_eq!(
            std::fs::metadata(&to).unwrap().permissions().mode() & 0o777,
            0o700
        );
        // Restored after the children, or the copy would have been locked out
        // of its own directory on the way in.
        assert_eq!(text(&to.join("secret.txt")), "shh\n");
    }

    /// Honest depth, not a symlink cycle: the walk is recursive, so something
    /// has to stop it before the worker thread's stack does.
    #[test]
    fn copy_refuses_a_tree_deeper_than_the_cap() {
        let dir = scratch("copy-deep");
        let mut deep = dir.join("deep");
        for _ in 0..(MAX_COPY_DEPTH + 4) {
            deep = deep.join("d");
        }
        std::fs::create_dir_all(&deep).unwrap();

        let refused = copy_path(
            dir.join("deep").to_string_lossy().into_owned(),
            dir.join("copied").to_string_lossy().into_owned(),
        );

        assert!(refused.unwrap_err().contains("nested deeper than"));
    }

    /// Every entry point runs the guard, not just the two the removable check
    /// covers: a relative path means a caller built it wrong.
    #[test]
    fn every_command_refuses_a_path_it_was_handed_wrong() {
        assert!(create_file("relative.txt".into()).is_err());
        assert!(create_dir("relative".into()).is_err());
        assert!(duplicate_path("relative.txt".into()).is_err());
        assert!(copy_path("relative.txt".into(), "/tmp/x".into()).is_err());
        assert!(copy_path("/tmp/x".into(), "/tmp/../etc/passwd".into()).is_err());
        assert!(create_file("/tmp/../etc/mangouste-probe".into()).is_err());
    }

    /// The fallback that makes a drag onto another mount work at all. Built from
    /// a synthetic error because a second filesystem is not portable in CI.
    #[test]
    #[cfg(unix)]
    fn cross_device_is_recognised_by_its_errno() {
        assert!(is_cross_device(&std::io::Error::from_raw_os_error(18)));
        assert!(!is_cross_device(&std::io::Error::from_raw_os_error(2)));
        assert!(!is_cross_device(&std::io::Error::from_raw_os_error(13)));
    }

    #[test]
    fn copy_refuses_to_overwrite() {
        let dir = scratch("copy-overwrite");
        let from = dir.join("a.txt");
        let to = dir.join("b.txt");
        std::fs::write(&from, "new\n").unwrap();
        std::fs::write(&to, "keep\n").unwrap();

        let refused = copy_path(
            from.to_string_lossy().into_owned(),
            to.to_string_lossy().into_owned(),
        );

        assert_eq!(refused.unwrap_err(), "already exists");
        assert_eq!(text(&to), "keep\n");
    }
}
