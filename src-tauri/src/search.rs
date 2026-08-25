//! Cross-file text search and replace, behind the sidebar's Find & Replace view.
//!
//! Matching is per line, so `^` and `$` mean what they look like they mean and a
//! query containing a newline finds nothing — a multi-line search is a different
//! feature with a different cost profile, and pretending to support it by
//! matching across a whole file would make every long minified file a hazard.
//!
//! Every result carries the byte span it was found at, and replacing takes those
//! spans back. That is what lets a match be dismissed in the UI and skipped by
//! the write: the pane never sends text it wants substituted, only the positions
//! it wants touched, and Rust re-runs the same matcher over the file to prove
//! those positions are still matches before it rewrites anything.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ignore::overrides::OverrideBuilder;
use ignore::{WalkBuilder, WalkState};
use regex::{Captures, Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::workspace::{read_text, save_text};

/// Largest file the sweep will read. A source file over this is generated,
/// vendored, or a database — none of which are what a repo-wide find is for.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Matches returned when the caller does not say, and the ceiling it can ask for.
/// The cap exists because the sweep is synchronous from the pane's point of view:
/// an unbounded `.` over a monorepo is a hang, not a search.
const DEFAULT_MAX_MATCHES: usize = 2_000;
const MAX_MATCHES: usize = 20_000;

/// Per-file ceiling, so one generated file cannot fill the whole result set and
/// push every other file's first hit off the end.
const MAX_FILE_MATCHES: usize = 200;

/// How much of a line travels with a match. A minified bundle is one 400 KB
/// line; sending it would cost more than the rest of the results put together.
const SNIPPET_BEFORE: usize = 120;
const SNIPPET_AFTER: usize = 240;
/// A match can itself be arbitrarily long (`.*` on that same minified line), and
/// only its position matters to the replace — the text is for the eye.
const SNIPPET_MATCH: usize = 200;

/// Compiled-pattern ceiling. The regex crate has no backtracking, so a pattern
/// cannot blow up at match time; it can still blow up at compile time, and this
/// turns that into an error message in the pane instead of a memory spike.
const REGEX_SIZE_LIMIT: usize = 1 << 20;

/// What the pane asked for, mirroring `SearchOptions` in `src/lib/types.ts`.
///
/// Every field defaults, so a caller that has not grown a toggle yet still sends
/// a valid request.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    /// Treat the query as a regex rather than literal text. Also what makes `$1`
    /// in a replacement mean a capture group.
    pub regex: bool,
    /// Comma-separated gitignore-style globs. Non-empty means "only these".
    pub include: String,
    /// Comma-separated globs to skip, applied after `include`.
    pub exclude: String,
    /// Absent is `true`: the tree the Explorer shows is the tree a find sweeps.
    pub respect_gitignore: Option<bool>,
    pub show_hidden: bool,
    pub max_matches: Option<usize>,
}

/// One match, with the line it sits on split around it so the pane can highlight
/// without knowing anything about byte offsets — a JS string is UTF-16 and these
/// offsets are UTF-8, so handing them over would be an invitation to a bug.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    /// 1-based, as the editor's gutter counts.
    pub line: u32,
    /// 1-based character column, for placing the caret when the file opens.
    pub column: u32,
    /// Absolute byte offsets in the file. The identity of the match for replace.
    pub start: u64,
    pub end: u64,
    pub before: String,
    pub matched: String,
    pub after: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    /// `path` as written from inside the searched root, which is what the pane shows.
    pub relative: String,
    /// The mtime the matches were read at, handed back on replace so a file
    /// claude rewrote in between is refused rather than clobbered.
    pub modified_ms: u64,
    pub matches: Vec<SearchMatch>,
    /// More matches in this file than `MAX_FILE_MATCHES`.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub files: Vec<FileHit>,
    pub total_matches: usize,
    /// The global cap stopped the sweep, so the results are a prefix of the truth.
    pub truncated: bool,
}

/// Compile the query into the one matcher both the search and the replace use.
///
/// Shared deliberately: a replace that built its own pattern could disagree with
/// the results the user was looking at about what a match is.
fn build_matcher(query: &str, options: &SearchOptions) -> Result<Regex, String> {
    let mut pattern = if options.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    if options.whole_word {
        // Non-capturing, so the group numbering a regex replacement refers to is
        // the user's own and not shifted by one.
        pattern = format!(r"\b(?:{pattern})\b");
    }
    RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .size_limit(REGEX_SIZE_LIMIT)
        .build()
        .map_err(|e| e.to_string())
}

/// Comma-separated globs into an `ignore` override set.
///
/// Include globs are a whitelist — one of them present means everything else is
/// excluded — which is exactly the "files to include" box's semantics.
fn build_overrides(root: &PathBuf, options: &SearchOptions) -> Result<ignore::overrides::Override, String> {
    let mut builder = OverrideBuilder::new(root);
    let mut any = false;
    for glob in options.include.split(',').map(str::trim).filter(|g| !g.is_empty()) {
        builder.add(glob).map_err(|e| e.to_string())?;
        any = true;
    }
    for glob in options.exclude.split(',').map(str::trim).filter(|g| !g.is_empty()) {
        builder.add(&format!("!{glob}")).map_err(|e| e.to_string())?;
        any = true;
    }
    if !any {
        return Ok(ignore::overrides::Override::empty());
    }
    builder.build().map_err(|e| e.to_string())
}

/// Largest offset at or below `at` that is a character boundary.
fn floor_boundary(text: &str, at: usize) -> usize {
    let mut at = at.min(text.len());
    while at > 0 && !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// Smallest offset at or above `at` that is a character boundary.
fn ceil_boundary(text: &str, at: usize) -> usize {
    let mut at = at.min(text.len());
    while at < text.len() && !text.is_char_boundary(at) {
        at += 1;
    }
    at
}

/// A window of `line` around `start..end`, with an ellipsis wherever it was cut.
fn snippet(line: &str, start: usize, end: usize) -> (String, String, String) {
    let left = floor_boundary(line, start.saturating_sub(SNIPPET_BEFORE));
    let mut before = String::new();
    if left > 0 {
        before.push('…');
    }
    before.push_str(&line[left..start]);

    let matched_end = ceil_boundary(line, (start + SNIPPET_MATCH).min(end));
    let mut matched = line[start..matched_end].to_string();
    if matched_end < end {
        matched.push('…');
    }

    let right = ceil_boundary(line, (end + SNIPPET_AFTER).min(line.len()));
    let mut after = line[end..right].to_string();
    if right < line.len() {
        after.push('…');
    }
    (before, matched, after)
}

/// Every match in one file's text, in reading order.
///
/// `budget` is what is left of the global cap; the return flags whether this
/// file had more to give than it was allowed to report.
fn matches_in(text: &str, matcher: &Regex, budget: usize) -> (Vec<SearchMatch>, bool) {
    let mut found = Vec::new();
    let mut truncated = false;
    let cap = budget.min(MAX_FILE_MATCHES);
    let mut offset = 0usize;

    for (index, raw) in text.split('\n').enumerate() {
        // A CRLF file's `\r` belongs to the line ending, not to the line: leaving
        // it in makes `$`-anchored patterns fail and puts a stray glyph at the
        // end of every snippet.
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        for found_match in matcher.find_iter(line) {
            // A pattern that can match nothing (`a*`) would otherwise report one
            // hit per character, and none of them are anything to replace.
            if found_match.start() == found_match.end() {
                continue;
            }
            if found.len() >= cap {
                truncated = true;
                break;
            }
            let (before, matched, after) = snippet(line, found_match.start(), found_match.end());
            found.push(SearchMatch {
                line: index as u32 + 1,
                column: line[..found_match.start()].chars().count() as u32 + 1,
                start: (offset + found_match.start()) as u64,
                end: (offset + found_match.end()) as u64,
                before,
                matched,
                after,
            });
        }
        if truncated {
            break;
        }
        // `split` consumed one `\n`, which the offsets of later lines include.
        offset += raw.len() + 1;
    }
    (found, truncated)
}

/// Search every file under `root` for `query`.
///
/// Async and parallel: a cold-cache sweep of a large repo is seconds of IO, and
/// the pane is blocked on it.
#[tauri::command(async)]
pub fn search_text(
    root: String,
    query: String,
    options: SearchOptions,
) -> Result<SearchOutcome, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    if query.is_empty() {
        return Ok(SearchOutcome { files: Vec::new(), total_matches: 0, truncated: false });
    }

    let matcher = Arc::new(build_matcher(&query, &options)?);
    let overrides = build_overrides(&root_path, &options)?;
    let respect_gitignore = options.respect_gitignore.unwrap_or(true);
    let cap = options
        .max_matches
        .unwrap_or(DEFAULT_MAX_MATCHES)
        .clamp(1, MAX_MATCHES);

    let hits: Arc<Mutex<Vec<FileHit>>> = Arc::new(Mutex::new(Vec::new()));
    let total = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(AtomicBool::new(false));

    let mut builder = WalkBuilder::new(&root_path);
    builder
        .hidden(!options.show_hidden)
        .git_ignore(respect_gitignore)
        .git_global(respect_gitignore)
        .git_exclude(respect_gitignore)
        .parents(respect_gitignore)
        .follow_links(false)
        .overrides(overrides);
    // More threads than this buys nothing: the sweep is IO-bound long before the
    // matcher is the bottleneck.
    if let Ok(cores) = std::thread::available_parallelism() {
        builder.threads(cores.get().min(8));
    }

    builder.build_parallel().run(|| {
        let matcher = Arc::clone(&matcher);
        let hits = Arc::clone(&hits);
        let total = Arc::clone(&total);
        let truncated = Arc::clone(&truncated);
        let root_path = root_path.clone();
        Box::new(move |entry| {
            let entry = match entry {
                Ok(entry) => entry,
                // An unreadable directory is not worth failing the whole sweep over.
                Err(_) => return WalkState::Continue,
            };
            if entry.depth() == 0 || entry.file_type().is_none_or(|t| !t.is_file()) {
                return WalkState::Continue;
            }
            let budget = cap.saturating_sub(total.load(Ordering::Relaxed));
            if budget == 0 {
                truncated.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            let path = entry.path();
            // `read_text` rejects the whole class of files a find has no business
            // opening — too large, binary, not a regular file — with the same
            // rules the editor opens through.
            let Ok(file) = read_text(path, Some(MAX_FILE_BYTES)) else {
                return WalkState::Continue;
            };
            let (matches, file_truncated) = matches_in(&file.content, &matcher, budget);
            if matches.is_empty() {
                return WalkState::Continue;
            }
            if file_truncated {
                truncated.store(true, Ordering::Relaxed);
            }
            total.fetch_add(matches.len(), Ordering::Relaxed);
            let relative = path
                .strip_prefix(&root_path)
                .unwrap_or(path)
                .to_string_lossy()
                .into_owned();
            hits.lock().expect("search results mutex").push(FileHit {
                path: path.to_string_lossy().into_owned(),
                relative,
                modified_ms: file.modified_ms,
                matches,
                truncated: file_truncated,
            });
            WalkState::Continue
        })
    });

    let mut files = Arc::try_unwrap(hits)
        .map(|lock| lock.into_inner().expect("search results mutex"))
        .unwrap_or_default();
    // A parallel walk finishes in whatever order the threads did; the pane needs
    // a stable list, and a repo-wide find reads as a tree.
    files.sort_by(|a, b| a.relative.cmp(&b.relative));

    Ok(SearchOutcome {
        total_matches: files.iter().map(|f| f.matches.len()).sum(),
        truncated: truncated.load(Ordering::Relaxed),
        files,
    })
}

/// One file to rewrite, as the pane's result list describes it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceTarget {
    pub path: String,
    /// The mtime the search read it at. Absent forces the write through, which
    /// is only reachable from an explicit "replace anyway".
    pub modified_ms: Option<u64>,
    /// Byte spans from the search results. Absent means every match in the file;
    /// present means only these, which is how a dismissed match stays untouched.
    pub spans: Option<Vec<[u64; 2]>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub path: String,
    pub replaced: usize,
    /// `None` on success. A refused file does not stop the others.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOutcome {
    pub files: Vec<ReplaceResult>,
    pub replaced: usize,
    pub failed: usize,
}

/// `content` with the requested matches substituted, and how many that was.
///
/// Runs the same line scan as `matches_in`, so a span only counts if it is still
/// exactly where a match is — a file edited since the search cannot have a
/// replacement dropped into the middle of unrelated text.
fn apply_replacements(
    content: &str,
    matcher: &Regex,
    replacement: &str,
    regex_mode: bool,
    spans: Option<&HashSet<(usize, usize)>>,
) -> (String, usize) {
    let mut out = String::with_capacity(content.len());
    let mut cursor = 0usize;
    let mut replaced = 0usize;
    let mut offset = 0usize;

    for raw in content.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        for captures in matcher.captures_iter(line) {
            let whole = captures.get(0).expect("group 0 always matches");
            if whole.start() == whole.end() {
                continue;
            }
            let span = (offset + whole.start(), offset + whole.end());
            if spans.is_some_and(|wanted| !wanted.contains(&span)) {
                continue;
            }
            out.push_str(&content[cursor..span.0]);
            if regex_mode {
                // `$1` and `${name}` mean what they mean in every other tool.
                // Only in regex mode: a literal find/replace of a price list
                // must not have `$1` in the replacement vanish.
                expand(&captures, replacement, &mut out);
            } else {
                out.push_str(replacement);
            }
            cursor = span.1;
            replaced += 1;
        }
        offset += raw.len() + 1;
    }
    out.push_str(&content[cursor..]);
    (out, replaced)
}

/// `Captures::expand`, named so the call site above reads.
fn expand(captures: &Captures<'_>, replacement: &str, out: &mut String) {
    captures.expand(replacement, out);
}

/// Rewrite the given files, replacing the matches the pane still has selected.
///
/// The query and options come back with the request rather than being remembered
/// between calls: the process holds no search state, so there is nothing that can
/// be stale in a way the caller cannot see.
#[tauri::command(async)]
pub fn replace_matches(
    query: String,
    options: SearchOptions,
    replacement: String,
    targets: Vec<ReplaceTarget>,
) -> Result<ReplaceOutcome, String> {
    if query.is_empty() {
        return Err("nothing to replace".to_string());
    }
    let matcher = build_matcher(&query, &options)?;
    let mut files = Vec::with_capacity(targets.len());
    let mut replaced_total = 0usize;
    let mut failed = 0usize;

    for target in targets {
        let wanted: Option<HashSet<(usize, usize)>> = target.spans.as_ref().map(|spans| {
            spans
                .iter()
                .map(|[start, end]| (*start as usize, *end as usize))
                .collect()
        });
        let outcome = (|| -> Result<usize, String> {
            let file = read_text(std::path::Path::new(&target.path), Some(MAX_FILE_BYTES))?;
            if let Some(expected) = target.modified_ms {
                if file.modified_ms != expected {
                    return Err("changed on disk since it was searched".to_string());
                }
            }
            let (next, replaced) = apply_replacements(
                &file.content,
                &matcher,
                &replacement,
                options.regex,
                wanted.as_ref(),
            );
            if replaced == 0 {
                // Nothing matched where the results said it would. Writing an
                // identical file would only bump the mtime and confuse the next
                // search.
                return Ok(0);
            }
            save_text(&target.path, &next, target.modified_ms)?;
            Ok(replaced)
        })();

        match outcome {
            Ok(replaced) => {
                replaced_total += replaced;
                files.push(ReplaceResult { path: target.path, replaced, error: None });
            }
            Err(error) => {
                failed += 1;
                files.push(ReplaceResult {
                    path: target.path,
                    replaced: 0,
                    error: Some(error),
                });
            }
        }
    }

    Ok(ReplaceOutcome { files, replaced: replaced_total, failed })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mangouste-search-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn options() -> SearchOptions {
        SearchOptions::default()
    }

    fn search(dir: &PathBuf, query: &str, options: SearchOptions) -> SearchOutcome {
        search_text(dir.to_string_lossy().into_owned(), query.to_string(), options).unwrap()
    }

    /// The shape the pane draws a row from: which line, which column, and the
    /// line split around the match.
    #[test]
    fn finds_matches_with_their_position_and_context() {
        let dir = scratch("basic");
        std::fs::write(dir.join("a.txt"), "alpha beta\nno hit here\nbeta again\n").unwrap();

        let found = search(&dir, "beta", options());
        assert_eq!(found.total_matches, 2);
        assert_eq!(found.files.len(), 1);
        assert_eq!(found.files[0].relative, "a.txt");

        let first = &found.files[0].matches[0];
        assert_eq!((first.line, first.column), (1, 7));
        assert_eq!((&*first.before, &*first.matched, &*first.after), ("alpha ", "beta", ""));
        // Byte offsets are absolute in the file, which is what replace keys off.
        assert_eq!((first.start, first.end), (6, 10));
        assert_eq!(found.files[0].matches[1].line, 3);
    }

    /// Case-insensitive by default, like every editor's find box.
    #[test]
    fn case_sensitivity_is_a_toggle() {
        let dir = scratch("case");
        std::fs::write(dir.join("a.txt"), "Beta\nbeta\n").unwrap();

        assert_eq!(search(&dir, "beta", options()).total_matches, 2);
        let strict = SearchOptions { case_sensitive: true, ..options() };
        assert_eq!(search(&dir, "beta", strict).total_matches, 1);
    }

    #[test]
    fn whole_word_does_not_match_inside_a_word() {
        let dir = scratch("word");
        std::fs::write(dir.join("a.txt"), "cat concatenate cat.\n").unwrap();

        assert_eq!(search(&dir, "cat", options()).total_matches, 3);
        let words = SearchOptions { whole_word: true, ..options() };
        assert_eq!(search(&dir, "cat", words).total_matches, 2);
    }

    /// A literal query is escaped, so a search for `a.c` is not a search for
    /// "a, anything, c".
    #[test]
    fn a_literal_query_is_not_a_pattern() {
        let dir = scratch("literal");
        std::fs::write(dir.join("a.txt"), "abc\na.c\n").unwrap();

        assert_eq!(search(&dir, "a.c", options()).total_matches, 1);
        let pattern = SearchOptions { regex: true, ..options() };
        assert_eq!(search(&dir, "a.c", pattern).total_matches, 2);
    }

    /// `a*` matches the empty string everywhere. Reporting those would drown the
    /// results in hits that are nothing to replace.
    #[test]
    fn zero_length_matches_are_not_results() {
        let dir = scratch("empty");
        std::fs::write(dir.join("a.txt"), "bbb\n").unwrap();

        let pattern = SearchOptions { regex: true, ..options() };
        assert_eq!(search(&dir, "a*", pattern).total_matches, 0);
    }

    #[test]
    fn include_and_exclude_globs_filter_the_sweep() {
        let dir = scratch("globs");
        std::fs::write(dir.join("a.rs"), "needle\n").unwrap();
        std::fs::write(dir.join("b.txt"), "needle\n").unwrap();
        std::fs::create_dir_all(dir.join("vendor")).unwrap();
        std::fs::write(dir.join("vendor/c.rs"), "needle\n").unwrap();

        assert_eq!(search(&dir, "needle", options()).total_matches, 3);

        let only_rust = SearchOptions { include: "*.rs".into(), ..options() };
        let hit = search(&dir, "needle", only_rust);
        assert_eq!(hit.total_matches, 2);

        let no_vendor = SearchOptions {
            include: "*.rs".into(),
            exclude: "vendor/**".into(),
            ..options()
        };
        let hit = search(&dir, "needle", no_vendor);
        assert_eq!(hit.total_matches, 1);
        assert_eq!(hit.files[0].relative, "a.rs");
    }

    /// A binary file is not text to search, and a huge one is not what a find is
    /// for. Both are skipped rather than failing the sweep.
    #[test]
    fn binary_and_oversized_files_are_skipped() {
        let dir = scratch("skip");
        std::fs::write(dir.join("a.txt"), "needle\n").unwrap();
        std::fs::write(dir.join("b.bin"), b"needle\0needle\n").unwrap();

        let found = search(&dir, "needle", options());
        assert_eq!(found.files.len(), 1);
        assert_eq!(found.files[0].relative, "a.txt");
    }

    /// The global cap has to hold, and the result has to admit it is a prefix.
    #[test]
    fn the_match_cap_truncates_and_says_so() {
        let dir = scratch("cap");
        std::fs::write(dir.join("a.txt"), "hit\n".repeat(50)).unwrap();

        let capped = SearchOptions { max_matches: Some(10), ..options() };
        let found = search(&dir, "hit", capped);
        assert!(found.truncated, "a capped sweep must say it was capped");
        assert_eq!(found.total_matches, 10);
    }

    #[test]
    fn replaces_every_match_when_no_spans_are_given() {
        let dir = scratch("replace-all");
        let file = dir.join("a.txt");
        std::fs::write(&file, "one two one\n").unwrap();
        let path = file.to_string_lossy().into_owned();

        let outcome = replace_matches(
            "one".into(),
            options(),
            "1".into(),
            vec![ReplaceTarget { path, modified_ms: None, spans: None }],
        )
        .unwrap();

        assert_eq!((outcome.replaced, outcome.failed), (2, 0));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "1 two 1\n");
    }

    /// The whole point of returning byte spans: a match the user dismissed in the
    /// pane is a match the write leaves alone.
    #[test]
    fn only_the_given_spans_are_replaced() {
        let dir = scratch("replace-spans");
        let file = dir.join("a.txt");
        std::fs::write(&file, "one two one\n").unwrap();
        let path = file.to_string_lossy().into_owned();

        let found = search(&dir, "one", options());
        let second = &found.files[0].matches[1];
        let outcome = replace_matches(
            "one".into(),
            options(),
            "1".into(),
            vec![ReplaceTarget {
                path,
                modified_ms: Some(found.files[0].modified_ms),
                spans: Some(vec![[second.start, second.end]]),
            }],
        )
        .unwrap();

        assert_eq!(outcome.replaced, 1);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "one two 1\n");
    }

    /// `$1` is a capture in regex mode and eight characters of text otherwise.
    #[test]
    fn capture_groups_expand_only_in_regex_mode() {
        let dir = scratch("captures");
        let file = dir.join("a.txt");
        std::fs::write(&file, "foo=1\n").unwrap();
        let path = file.to_string_lossy().into_owned();

        let pattern = SearchOptions { regex: true, ..options() };
        replace_matches(
            r"(\w+)=(\d+)".into(),
            pattern,
            "$2=$1".into(),
            vec![ReplaceTarget { path: path.clone(), modified_ms: None, spans: None }],
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "1=foo\n");

        std::fs::write(&file, "cost\n").unwrap();
        replace_matches(
            "cost".into(),
            options(),
            "$1".into(),
            vec![ReplaceTarget { path, modified_ms: None, spans: None }],
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "$1\n");
    }

    /// claude edits the same tree, so a file that moved under the results is
    /// refused — and one refusal does not cost the other files their replace.
    #[test]
    fn a_stale_file_is_refused_without_stopping_the_rest() {
        let dir = scratch("stale");
        let stale = dir.join("stale.txt");
        let fresh = dir.join("fresh.txt");
        std::fs::write(&stale, "needle\n").unwrap();
        std::fs::write(&fresh, "needle\n").unwrap();

        let found = search(&dir, "needle", options());
        let fresh_hit = found.files.iter().find(|f| f.relative == "fresh.txt").unwrap();
        let stale_hit = found.files.iter().find(|f| f.relative == "stale.txt").unwrap();

        let outcome = replace_matches(
            "needle".into(),
            options(),
            "thread".into(),
            vec![
                ReplaceTarget {
                    path: stale_hit.path.clone(),
                    modified_ms: Some(stale_hit.modified_ms + 1),
                    spans: None,
                },
                ReplaceTarget {
                    path: fresh_hit.path.clone(),
                    modified_ms: Some(fresh_hit.modified_ms),
                    spans: None,
                },
            ],
        )
        .unwrap();

        assert_eq!((outcome.replaced, outcome.failed), (1, 1));
        assert_eq!(std::fs::read_to_string(&stale).unwrap(), "needle\n");
        assert_eq!(std::fs::read_to_string(&fresh).unwrap(), "thread\n");
    }

    /// A pattern that will not compile is an error in the box, not a panic.
    #[test]
    fn a_broken_pattern_is_an_error() {
        let dir = scratch("broken");
        std::fs::write(dir.join("a.txt"), "x\n").unwrap();
        let pattern = SearchOptions { regex: true, ..options() };
        let refused = search_text(dir.to_string_lossy().into_owned(), "(".into(), pattern);
        assert!(refused.is_err());
    }
}
