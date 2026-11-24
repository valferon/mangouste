//! What each account is called on screen.
//!
//! An account's name is its directory: `main` for `~/.claude`, the folder name
//! for the rest. The CLI's config dir, the macOS keychain item (named by a
//! hash of that path) and every running child are tied to it, so it does not
//! change once made, and `main` could not be renamed at all. What is shown is
//! a label on top of it: the one the person gave the account, else the address
//! it is signed in as, else the name.
//!
//! The labels are the app's, kept in a file beside the account choice for the
//! reason the choice is: every window shows them, and none of them owns them.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;

/// The longest label kept. The switcher sits in a pane header, and past this
/// a label is a sentence.
pub const MAX_LABEL: usize = 40;

/// Account name to label. Sorted, so the file reads the same from one save to
/// the next.
pub type Labels = BTreeMap<String, String>;

/// Another account, as far as a label can be mistaken for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Other {
    pub name: String,
    /// The address it is signed in as: what it is called while it has no label.
    pub email: Option<String>,
}

fn labels_file() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("mangouste").join("account-labels.json"))
}

/// A character that takes no room on screen, or moves the ones around it:
/// zero-width spaces and joiners, the direction marks and overrides, the
/// line and paragraph separators, the soft hyphen, the byte-order mark.
///
/// A label made of these is a blank row, and one hidden inside a name makes
/// two labels that read the same and compare different, which is the mix-up
/// the duplicate rule is there to stop.
fn invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{2028}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

/// What the person typed, as it will be kept: trimmed, and `None` when there
/// is nothing left, which is how a label is taken off again.
pub fn clean(label: &str) -> Result<Option<String>, String> {
    let label = label.trim();
    if label.is_empty() {
        return Ok(None);
    }
    if label.chars().any(|c| c.is_control() || invisible(c)) {
        return Err("a name cannot hold control or invisible characters".into());
    }
    if label.chars().count() > MAX_LABEL {
        return Err(format!("a name is at most {MAX_LABEL} characters"));
    }
    Ok(Some(label.to_string()))
}

/// The labels in a file's text. An entry that would not have been accepted
/// when typed is dropped, alone: the file can be edited by hand, what it says
/// ends up in a menu, and one bad line is not a reason to lose the rest.
fn parse(text: &str) -> Result<Labels, String> {
    let stored: BTreeMap<String, serde_json::Value> =
        serde_json::from_str(text).map_err(|e| e.to_string())?;
    Ok(stored
        .into_iter()
        .filter_map(|(name, label)| {
            let label = label.as_str()?;
            let kept = clean(label).ok().flatten()?;
            (crate::account::valid_name(&name) && kept == label).then_some((name, kept))
        })
        .collect())
}

/// The labels in `path`, for showing: a file that is missing or cannot be
/// made sense of is no labels.
fn read_from(path: Option<&Path>) -> Labels {
    path.and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| parse(&text).ok())
        .unwrap_or_default()
}

/// The labels in `path`, for changing. Only a file that is not there reads
/// as empty. One that is there and cannot be read or parsed is an error,
/// because the next thing done with the answer is to write it back, and
/// writing back "no labels" would be how one typo cost every name.
fn read_to_change(path: &Path) -> Result<Labels, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Labels::new()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    parse(&text).map_err(|e| format!("{} is not valid: {e}. Fix or remove it.", path.display()))
}

fn write_to(path: &Path, labels: &Labels) -> Result<(), String> {
    static WRITES: AtomicU64 = AtomicU64::new(0);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(labels).map_err(|e| e.to_string())?;
    // Written beside and renamed over, as the account choice is: a crash
    // mid-write must not leave half a file. Under a name of this process's and
    // this write's own, so two copies of the app saving at once each rename
    // their own file rather than one renaming the other's away.
    let tmp = path.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        WRITES.fetch_add(1, Ordering::Relaxed)
    ));
    let written = std::fs::write(&tmp, format!("{text}\n"))
        .and_then(|()| std::fs::rename(&tmp, path))
        .map_err(|e| e.to_string());
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// Every label on disk.
pub fn read() -> Labels {
    read_from(labels_file().as_deref())
}

/// `labels` with `name` called `label`, or with its label taken off.
///
/// Refused when another account already answers to it: by its label, by its
/// directory name, or by the address it is signed in as, since those are what
/// it shows as. Two rows reading the same in the switcher is how the wrong
/// account gets picked. Compared without case, since that is how it is read.
///
/// Labels of accounts that are no longer there are dropped on the way: one
/// left behind by a directory deleted by hand would otherwise hold its name
/// against every account, with no row to take it off from.
fn relabelled(
    labels: &Labels,
    name: &str,
    label: Option<String>,
    others: &[Other],
) -> Result<Labels, String> {
    let kept: Labels = others
        .iter()
        .filter_map(|other| {
            let theirs = labels.get(&other.name)?;
            Some((other.name.clone(), theirs.clone()))
        })
        .collect();
    let Some(label) = label else {
        return Ok(kept);
    };
    let wanted = label.to_lowercase();
    let same = |text: &str| text.to_lowercase() == wanted;
    let taken = others.iter().any(|other| {
        same(&other.name)
            || other.email.as_deref().is_some_and(same)
            || kept.get(&other.name).is_some_and(|theirs| same(theirs))
    });
    if taken {
        return Err(format!("another account is already called {label}"));
    }
    Ok(kept
        .into_iter()
        .chain(std::iter::once((name.to_string(), label)))
        .collect())
}

/// One read-change-write at a time in this process: two windows naming
/// accounts at the same moment would otherwise each write the file without
/// the other's label.
fn writing() -> &'static Mutex<()> {
    static WRITING: Mutex<()> = Mutex::new(());
    &WRITING
}

/// Whether `name` could be called what was typed, without calling it that.
/// For a caller with something to do first that is not undone as easily as
/// a label: making the account's directory.
pub fn check(name: &str, typed: &str, others: &[Other]) -> Result<(), String> {
    let label = clean(typed)?;
    let path = labels_file().ok_or("no config directory to keep the name in")?;
    relabelled(&read_to_change(&path)?, name, label, others).map(|_| ())
}

fn set_in(path: &Path, name: &str, typed: &str, others: &[Other]) -> Result<(), String> {
    let label = clean(typed)?;
    let _guard = writing().lock();
    let next = relabelled(&read_to_change(path)?, name, label, others)?;
    write_to(path, &next)
}

/// Call `name` what was typed, or take its label off when that is blank.
/// `others` is every other account there is.
pub fn set(name: &str, typed: &str, others: &[Other]) -> Result<(), String> {
    let path = labels_file().ok_or("no config directory to keep the name in")?;
    set_in(&path, name, typed, others)
}

fn forget_in(path: &Path, name: &str) {
    let _guard = writing().lock();
    let Ok(labels) = read_to_change(path) else {
        return;
    };
    if !labels.contains_key(name) {
        return;
    }
    let next: Labels = labels
        .into_iter()
        .filter(|(other, _)| other != name)
        .collect();
    let _ = write_to(path, &next);
}

/// Drop the label of an account that is gone, so a later account made under
/// the same directory name does not inherit it. Best effort: a label left
/// behind is shown to nobody, and is dropped at the next rename.
pub fn forget(name: &str) {
    if let Some(path) = labels_file() {
        forget_in(&path, name);
    }
}

/// What an account is called: the label it was given, else the address it is
/// signed in as, else its name.
pub fn title(label: Option<&str>, email: Option<&str>, name: &str) -> String {
    label.or(email).unwrap_or(name).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(pairs: &[(&str, &str)]) -> Labels {
        pairs
            .iter()
            .map(|(name, label)| (name.to_string(), label.to_string()))
            .collect()
    }

    fn others(all: &[(&str, Option<&str>)]) -> Vec<Other> {
        all.iter()
            .map(|(name, email)| Other {
                name: name.to_string(),
                email: email.map(str::to_string),
            })
            .collect()
    }

    /// A labels file in a directory of its own, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("mangouste-labels-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            Scratch(dir)
        }

        fn file(&self) -> PathBuf {
            self.0.join("nested").join("account-labels.json")
        }

        fn write(&self, text: &str) {
            std::fs::create_dir_all(self.file().parent().unwrap()).unwrap();
            std::fs::write(self.file(), text).unwrap();
        }

        /// Everything in the file's directory but the file itself.
        fn strays(&self) -> Vec<String> {
            std::fs::read_dir(self.file().parent().unwrap())
                .unwrap()
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| name != "account-labels.json")
                .collect()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_label_is_trimmed_and_a_blank_one_is_none() {
        assert_eq!(clean("  Ops team "), Ok(Some("Ops team".into())));
        assert_eq!(clean(""), Ok(None));
        assert_eq!(clean("   "), Ok(None));
    }

    #[test]
    fn a_label_is_one_short_line() {
        assert!(clean("two\nlines").is_err());
        assert!(clean("tab\there").is_err());
        assert!(clean(&"x".repeat(MAX_LABEL)).is_ok());
        assert!(clean(&"x".repeat(MAX_LABEL + 1)).is_err());
        // Counted in characters, not bytes: accents are not a longer name.
        assert!(clean(&"é".repeat(MAX_LABEL)).is_ok());
    }

    /// A zero-width space is not blank to `trim`, and inside a name it makes
    /// a second "Ops" that reads the same and compares different.
    #[test]
    fn a_label_cannot_hold_what_does_not_show() {
        assert!(clean("\u{200B}").is_err());
        assert!(clean("Ops\u{200B}").is_err());
        assert!(clean("Ops\u{202E}spO").is_err());
        assert!(clean("Ops\u{2028}team").is_err());
        assert!(clean("\u{FEFF}Ops").is_err());
        // Ordinary letters from anywhere are fine, and so is an emoji.
        assert!(clean("Équipe réseau 日本 🦦").is_ok());
    }

    #[test]
    fn the_title_is_the_label_then_the_address_then_the_name() {
        assert_eq!(title(Some("Ops"), Some("o@example.com"), "work"), "Ops");
        assert_eq!(title(None, Some("o@example.com"), "work"), "o@example.com");
        assert_eq!(title(None, None, "work"), "work");
    }

    #[test]
    fn naming_an_account_leaves_the_others_as_they_were() {
        let before = labels(&[("main", "Personal")]);
        let after = relabelled(
            &before,
            "work",
            Some("Ops".into()),
            &others(&[("main", None)]),
        );
        assert_eq!(after, Ok(labels(&[("main", "Personal"), ("work", "Ops")])));
        // The map handed in is not the one changed.
        assert_eq!(before, labels(&[("main", "Personal")]));
    }

    #[test]
    fn an_account_can_be_renamed_and_un_named() {
        let before = labels(&[("work", "Ops")]);
        let rest = others(&[("main", None)]);
        assert_eq!(
            relabelled(&before, "work", Some("Client".into()), &rest),
            Ok(labels(&[("work", "Client")]))
        );
        assert_eq!(relabelled(&before, "work", None, &rest), Ok(Labels::new()));
        // Its own current label, and its own directory name, are not a clash.
        assert!(relabelled(&before, "work", Some("ops".into()), &rest).is_ok());
        assert!(relabelled(&before, "work", Some("work".into()), &rest).is_ok());
    }

    /// Two rows reading the same in the switcher is how the wrong account
    /// gets picked. An account shows as its label, else its address, else
    /// its directory name, and a label may be none of another's three.
    #[test]
    fn a_label_another_account_answers_to_is_refused() {
        let before = labels(&[("work", "Ops")]);
        let rest = others(&[("work", Some("o@example.com"))]);
        let naming = |label: &str| relabelled(&before, "main", Some(label.into()), &rest);
        assert!(naming("Ops").is_err());
        assert!(naming("OPS").is_err());
        assert!(naming("work").is_err());
        assert!(naming("O@Example.com").is_err());
        assert!(naming("Mine").is_ok());
    }

    /// A directory deleted by hand leaves its label behind, with no row to
    /// take it off from. It must not hold the name against the accounts that
    /// are still there, and it goes at the next save.
    #[test]
    fn a_label_left_by_an_account_that_is_gone_blocks_nothing_and_is_dropped() {
        let before = labels(&[("gone", "Ops"), ("work", "Client")]);
        let rest = others(&[("work", None)]);
        assert_eq!(
            relabelled(&before, "main", Some("Ops".into()), &rest),
            Ok(labels(&[("main", "Ops"), ("work", "Client")]))
        );
    }

    #[test]
    fn labels_round_trip_through_the_file_and_leave_nothing_beside_it() {
        let scratch = Scratch::new("round-trip");
        let path = scratch.file();
        assert_eq!(read_from(Some(&path)), Labels::new());
        let saved = labels(&[("main", "Personal"), ("work", "Ops team")]);
        write_to(&path, &saved).unwrap();
        write_to(&path, &saved).unwrap();
        assert_eq!(read_from(Some(&path)), saved);
        assert_eq!(scratch.strays(), Vec::<String>::new());
    }

    /// The file can be edited by hand, and what it says ends up in a menu.
    /// One bad entry goes; the rest stay.
    #[test]
    fn entries_that_would_not_have_been_accepted_are_dropped_alone() {
        let scratch = Scratch::new("junk");
        let long = "x".repeat(MAX_LABEL + 1);
        scratch.write(
            &serde_json::json!({
                "work": "Ops",
                "../escape": "Nope",
                "main": "  padded  ",
                "client": long,
                "other": "",
                "typo": 5,
                "hidden": "Ops\u{200B}",
            })
            .to_string(),
        );
        assert_eq!(read_from(Some(&scratch.file())), labels(&[("work", "Ops")]));
        assert_eq!(
            read_to_change(&scratch.file()),
            Ok(labels(&[("work", "Ops")]))
        );
    }

    #[test]
    fn naming_writes_the_file_and_forgetting_takes_one_label_out() {
        let scratch = Scratch::new("set");
        let path = scratch.file();
        let rest = others(&[("main", None)]);
        set_in(&path, "work", "  Ops team ", &rest).unwrap();
        set_in(&path, "main", "Personal", &others(&[("work", None)])).unwrap();
        assert_eq!(
            read_from(Some(&path)),
            labels(&[("main", "Personal"), ("work", "Ops team")])
        );
        // Refused, and the file is as it was.
        assert!(set_in(&path, "main", "ops TEAM", &others(&[("work", None)])).is_err());
        assert_eq!(
            read_from(Some(&path)).get("main").map(String::as_str),
            Some("Personal")
        );
        // Blank takes the label off.
        set_in(&path, "main", "  ", &others(&[("work", None)])).unwrap();
        assert_eq!(read_from(Some(&path)), labels(&[("work", "Ops team")]));

        forget_in(&path, "work");
        assert_eq!(read_from(Some(&path)), Labels::new());
        forget_in(&path, "never-there");
        assert_eq!(scratch.strays(), Vec::<String>::new());
    }

    /// The next thing done with what was read is to write it back. A file
    /// that cannot be made sense of reads as no labels for showing, and must
    /// not be what gets saved over every name there was.
    #[test]
    fn a_file_that_cannot_be_read_is_left_alone_rather_than_emptied() {
        let scratch = Scratch::new("broken");
        let path = scratch.file();
        scratch.write("{ \"work\": \"Ops\", ");
        assert_eq!(read_from(Some(&path)), Labels::new());

        let outcome = set_in(&path, "main", "Personal", &others(&[("work", None)]));

        assert!(outcome.is_err_and(|e| e.contains("is not valid")));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{ \"work\": \"Ops\", "
        );
        forget_in(&path, "work");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{ \"work\": \"Ops\", "
        );
    }
}
