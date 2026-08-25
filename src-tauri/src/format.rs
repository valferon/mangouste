//! Reformat a buffer with whatever formatter the repo already uses.
//!
//! Text in, text out — the buffer never goes to disk to be formatted. Two
//! reasons, both of them the second writer: a save carries the mtime the bytes
//! were read at (see `workspace::write_text_file`), so formatting through a
//! save-then-reload would either trip its own staleness check or teach the
//! editor to skip it; and claude is editing the same tree, so a format that
//! writes is a format that can land on top of an edit nobody has seen yet.
//! Formatting an unsaved draft also has to work, which a file-based formatter
//! cannot do at all.
//!
//! Nothing here is configured. Every formatter below reads its own rules from
//! the repo — `.prettierrc`, `rustfmt.toml`, `pyproject.toml` — so the answer to
//! "which style" is the one the repo already gives its own tooling, and a repo
//! with no formatter installed is told so rather than being restyled by whatever
//! happened to be on the machine.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Formatted {
    pub text: String,
    /// What ran, for the editor's status line: `prettier`, `rustfmt`.
    pub formatter: String,
    /// False when the formatter handed back exactly what it was given, which is
    /// worth saying: it is the difference between "already tidy" and "did nothing".
    pub changed: bool,
}

/// One way to format a file: a binary to look for, and the arguments that make
/// it read stdin and write stdout.
struct Candidate {
    /// Bare name, resolved against `node_modules/.bin` and the child PATH.
    bin: &'static str,
    /// `{path}` becomes the file's path and `{edition}` the crate's Rust edition.
    /// The path is for the formatter's own config lookup and error messages; none
    /// of these read the file itself, which is the whole point.
    args: &'static [&'static str],
    /// Also look in `node_modules/.bin`, walking up from the file. The repo's own
    /// pinned version beats a global install of the same tool.
    node: bool,
}

const fn node(bin: &'static str, args: &'static [&'static str]) -> Candidate {
    Candidate { bin, args, node: true }
}

const fn tool(bin: &'static str, args: &'static [&'static str]) -> Candidate {
    Candidate { bin, args, node: false }
}

/// Extension → the formatters to try, in order. First one installed wins.
///
/// Adding a language is a row here and nothing else. The list is deliberately
/// short: these are the formatters that read stdin, take their rules from the
/// repo, and are what the repo's own `fmt` script would have run.
const TABLE: &[(&[&str], &[Candidate])] = &[
    (
        &[
            "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc", "json5",
            "css", "scss", "less", "html", "vue", "svelte", "md", "mdx", "yml", "yaml",
            "graphql", "gql",
        ],
        &[
            node("prettier", &["--stdin-filepath", "{path}"]),
            node("biome", &["format", "--stdin-file-path", "{path}"]),
            node("dprint", &["fmt", "--stdin", "{path}"]),
        ],
    ),
    // Editions are not backwards compatible in the direction that matters here:
    // rustfmt defaults to 2015, where `async` is not a keyword, so formatting
    // any modern crate without saying so mangles it or fails outright.
    (&["rs"], &[tool("rustfmt", &["--edition", "{edition}"])]),
    (&["go"], &[tool("gofmt", &[])]),
    (
        &["py", "pyi"],
        &[
            tool("ruff", &["format", "--stdin-filename", "{path}", "-"]),
            tool("black", &["--quiet", "--stdin-filename", "{path}", "-"]),
        ],
    ),
    (&["toml"], &[tool("taplo", &["format", "-"])]),
    (&["lua"], &[tool("stylua", &["--stdin-filepath", "{path}", "-"])]),
    (&["sh", "bash", "zsh"], &[tool("shfmt", &["-filename", "{path}"])]),
    (
        &["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "m", "mm", "java", "proto"],
        &[tool("clang-format", &["--assume-filename={path}"])],
    ),
];

/// The formatters that claim this extension, or empty for one nothing claims.
fn candidates_for(extension: &str) -> &'static [Candidate] {
    let extension = extension.to_ascii_lowercase();
    for (extensions, candidates) in TABLE {
        if extensions.contains(&extension.as_str()) {
            return candidates;
        }
    }
    &[]
}

/// How deep to walk looking for `node_modules` or a `Cargo.toml`.
///
/// A bound rather than "until the root": a path on a network mount costs a stat
/// per level, and no repo layout puts its manifest thirty directories up.
const WALK_LIMIT: usize = 30;

/// `node_modules/.bin/<bin>`, walking up from `from`.
///
/// A workspace installs its tools at the root and its packages live below it, so
/// the walk is what makes a monorepo work at all — and it is why the repo's
/// pinned prettier is found before a global one.
fn local_node_bin(from: &Path, bin: &str) -> Option<PathBuf> {
    for dir in from.ancestors().take(WALK_LIMIT) {
        let candidate = dir.join("node_modules").join(".bin").join(bin);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// A bare name resolved against the PATH we would hand a child.
///
/// `child_path_dirs` rather than our own PATH, for the reason `crate::env`
/// exists: a windowed macOS launch inherits four system directories, so the
/// Homebrew or nvm formatter the user actually installed is invisible to
/// `Command::new("prettier")` while being on the PATH of every terminal they own.
fn path_bin(bin: &str) -> Option<PathBuf> {
    for dir in crate::env::child_path_dirs() {
        let candidate = dir.join(bin);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// The Rust edition of the crate `from` belongs to, defaulting to 2021.
///
/// Read by hand rather than with a TOML parser: the one line wanted is
/// `edition = "2021"` under `[package]`, and the first `edition` key in the file
/// is it — a `[workspace.package]` inherited edition reads the same way, and a
/// dependency's `edition` cannot appear here at all.
fn rust_edition(from: &Path) -> String {
    for dir in from.ancestors().take(WALK_LIMIT) {
        let manifest = dir.join("Cargo.toml");
        let Ok(text) = std::fs::read_to_string(&manifest) else {
            continue;
        };
        for line in text.lines() {
            let line = line.trim();
            let Some(rest) = line.strip_prefix("edition") else {
                continue;
            };
            let Some(value) = rest.trim_start().strip_prefix('=') else {
                continue;
            };
            let year = value.trim().trim_matches('"').trim_matches('\'');
            if year.len() == 4 && year.chars().all(|c| c.is_ascii_digit()) {
                return year.to_string();
            }
        }
    }
    "2021".to_string()
}

/// rustfmt's `--emit stdout` prefixes its output with the input's name and a
/// blank line. Reading from stdin it names it `stdin`, and older releases printed
/// that header even without `--emit`. Dropped rather than depended on: the header
/// is not Rust, and pasting it back into the buffer would break the file.
fn strip_stdin_header(text: &str) -> &str {
    let Some(rest) = text.strip_prefix("stdin:\n") else {
        return text;
    };
    rest.strip_prefix('\n').unwrap_or(rest)
}

/* ---------- the one formatter that is not a process ---------- */

/// Extensions the built-in re-indenter answers for, once nothing else has.
const JSON_EXTENSIONS: &[&str] = &["json", "jsonc", "json5"];

/// Two spaces: prettier's own default for JSON, so a repo that installs prettier
/// later sees no reformatting churn over the files this touched first.
const JSON_INDENT: &str = "  ";

/// What was last emitted. All the structure a re-indenter needs to decide where a
/// line break goes — and to refuse input that is not JSON at all.
#[derive(PartialEq, Clone, Copy)]
enum Prev {
    Start,
    Open,
    Close,
    Value,
    Comma,
    Colon,
    Comment,
}

/// Take the pending line break, indented to `depth`.
fn break_line(out: &mut String, newline: &str, depth: usize, pending: &mut bool) {
    if !*pending {
        return;
    }
    out.push_str(newline);
    for _ in 0..depth {
        out.push_str(JSON_INDENT);
    }
    *pending = false;
}

/// `line L, column C` of `at`, so an error is something to act on.
fn position(bytes: &[u8], at: usize) -> String {
    let line = 1 + bytes[..at].iter().filter(|byte| **byte == b'\n').count();
    let start = bytes[..at].iter().rposition(|byte| *byte == b'\n').map_or(0, |i| i + 1);
    format!("line {line}, column {}", 1 + at - start)
}

/// Index just past the string opening at `open`, or None if it never closes.
fn string_end(bytes: &[u8], open: usize) -> Option<usize> {
    let quote = bytes[open];
    let mut index = open + 1;
    while index < bytes.len() {
        match bytes[index] {
            // A backslash escapes whatever follows — a quote, or another
            // backslash — so it is stepped over as a pair.
            b'\\' => index += 2,
            byte if byte == quote => return Some(index + 1),
            // A raw newline inside a string is JSON's own error, and calling it
            // one here stops an unterminated string from swallowing the rest of
            // the file in search of a closing quote.
            b'\n' => return None,
            _ => index += 1,
        }
    }
    None
}

/// Re-indent JSON without a formatter installed.
///
/// The one formatter here that is not a process, for the one file type whose
/// formatting is not a matter of opinion — and because an editor that cannot
/// pretty-print a `package.json` until someone installs a node toolchain has a
/// hole in it. Every other language stays a repo-installed tool.
///
/// A re-indenter and deliberately not a serializer: each token is copied out byte
/// for byte and only the whitespace between them is rewritten. A round trip
/// through `serde_json::Value` would sort every object's keys — its map is a
/// `BTreeMap` — renormalise numbers and rewrite escapes, which is three ways to
/// hand back a file that is no longer the one that was opened. This way `1e400`,
/// `-0`, `"é"` and the order of `dependencies` all survive.
///
/// Comments and trailing commas pass through, so the jsonc and json5 that tooling
/// configs are written in are re-indented rather than rejected. Anything not
/// JSON-shaped is refused rather than mangled: an unterminated string, a bracket
/// that does not match, two values with no comma between them.
fn reindent_json(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    // Whatever the file already used. Rewriting every line ending is not a
    // formatting change anyone asked for, and on a CRLF repo it is the whole file.
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = String::with_capacity(bytes.len() + bytes.len() / 8);
    let mut stack: Vec<u8> = Vec::new();
    let mut prev = Prev::Start;
    let mut pending = false;
    let mut index = 0;

    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_whitespace() {
            index += 1;
            continue;
        }
        // Two values with nothing between them. Not JSON, and the re-indenter
        // would run them together into one token.
        let wants_comma = prev == Prev::Value || prev == Prev::Close;

        match byte {
            b'{' | b'[' => {
                if wants_comma {
                    return Err(format!("expected a comma at {}", position(bytes, index)));
                }
                break_line(&mut out, newline, stack.len(), &mut pending);
                let closer = if byte == b'{' { b'}' } else { b']' };
                let next = bytes[index + 1..]
                    .iter()
                    .position(|byte| !byte.is_ascii_whitespace())
                    .map(|offset| index + 1 + offset);
                // An empty container is a value, not a block: `{}` and `[]` stay
                // on the line they were on, as every formatter writes them.
                if let Some(at) = next.filter(|at| bytes[*at] == closer) {
                    out.push(byte as char);
                    out.push(closer as char);
                    prev = Prev::Close;
                    index = at + 1;
                    continue;
                }
                out.push(byte as char);
                stack.push(closer);
                pending = true;
                prev = Prev::Open;
                index += 1;
            }
            b'}' | b']' => {
                if stack.pop() != Some(byte) {
                    return Err(format!("unbalanced bracket at {}", position(bytes, index)));
                }
                // A closing bracket always starts its own line, whatever preceded
                // it — including a trailing comma, which is why `pending` is set
                // here rather than only inherited.
                pending = true;
                break_line(&mut out, newline, stack.len(), &mut pending);
                out.push(byte as char);
                prev = Prev::Close;
                index += 1;
            }
            b',' => {
                out.push(',');
                pending = true;
                prev = Prev::Comma;
                index += 1;
            }
            b':' => {
                out.push_str(": ");
                prev = Prev::Colon;
                index += 1;
            }
            // Single quotes are json5's; in strict JSON they are a syntax error
            // the formatter is not the place to report.
            b'"' | b'\'' => {
                if wants_comma {
                    return Err(format!("expected a comma at {}", position(bytes, index)));
                }
                break_line(&mut out, newline, stack.len(), &mut pending);
                let end = string_end(bytes, index)
                    .ok_or_else(|| format!("unterminated string at {}", position(bytes, index)))?;
                out.push_str(&text[index..end]);
                prev = Prev::Value;
                index = end;
            }
            b'/' if matches!(bytes.get(index + 1), Some(b'/') | Some(b'*')) => {
                break_line(&mut out, newline, stack.len(), &mut pending);
                let end = if bytes[index + 1] == b'/' {
                    bytes[index..]
                        .iter()
                        .position(|byte| *byte == b'\n')
                        .map_or(bytes.len(), |offset| index + offset)
                } else {
                    let close = text[index + 2..].find("*/").ok_or_else(|| {
                        format!("unterminated comment at {}", position(bytes, index))
                    })?;
                    index + 2 + close + 2
                };
                out.push_str(text[index..end].trim_end());
                // A comment ends its line: the value written under it is not
                // going to be pulled up beside it.
                pending = true;
                prev = Prev::Comment;
                index = end;
            }
            _ => {
                if wants_comma {
                    return Err(format!("expected a comma at {}", position(bytes, index)));
                }
                break_line(&mut out, newline, stack.len(), &mut pending);
                // A bare run: a number, `true`, `null`, or a json5 unquoted key.
                let end = bytes[index..]
                    .iter()
                    .position(|byte| byte.is_ascii_whitespace() || b",:{}[]\"'/".contains(byte))
                    .map_or(bytes.len(), |offset| index + offset);
                out.push_str(&text[index..end]);
                prev = Prev::Value;
                index = end;
            }
        }
    }

    if !stack.is_empty() {
        return Err("unclosed bracket at the end of the file".to_string());
    }
    // Whitespace only, or empty. There is nothing to indent, and a lone newline
    // would be a change with no content in it.
    if out.is_empty() {
        return Ok(text.to_string());
    }
    out.push_str(newline);
    Ok(out)
}

/// Pipe `text` through `bin`, returning its stdout.
fn run(bin: &Path, args: &[String], cwd: &Path, text: &str) -> Result<String, String> {
    let mut child = crate::env::with_child_path(&mut Command::new(bin))
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run {}: {e}", bin.display()))?;

    let mut stdin = child.stdin.take().expect("stdin was piped");
    let input = text.to_owned();
    // Written from its own thread, and read back with `wait_with_output`: a
    // formatter that starts printing before it has read everything deadlocks a
    // single-threaded write against a full pipe once the file is bigger than one.
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
    let output = child
        .wait_with_output()
        .map_err(|e| format!("{} failed: {e}", bin.display()))?;
    // A formatter that rejected its input closes the pipe early, so a write
    // error here is usually one of the failures below saying it differently. It
    // is only worth reporting once nothing else has explained the run.
    let write_failed = !matches!(writer.join(), Ok(Ok(())));

    // The resolved path, not the name the candidate was written as: `run` is
    // handed `/usr/bin/rustfmt` as often as `rustfmt`, and a message that leads
    // with an absolute path buries what it is trying to say.
    let name = bin
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| bin.display().to_string());

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{name} exited {}", output.status)
        } else {
            // Attributed, because a bare `error: expected one of ...` in the
            // editor names neither the formatter nor the fact that one ran.
            format!("{name}: {stderr}")
        });
    }

    let formatted = String::from_utf8(output.stdout)
        .map_err(|_| format!("{name} returned text that is not UTF-8"))?;
    // An empty answer to a non-empty buffer is not a format, and applying it
    // would empty the editor. Some formatters do this when handed a file type
    // they only half recognise.
    //
    // Checked before the write, and not after it as it once was: a formatter
    // that exits 0 without reading stdin fails the write with EPIPE *and*
    // returns nothing, and which of the two is observed comes down to whether
    // the buffer fitted in the pipe before the child exited. It read as a race
    // — passing on a developer machine, failing in CI — and the empty output is
    // the more useful half of it anyway, since that is what would empty the
    // editor.
    if formatted.is_empty() && !text.is_empty() {
        return Err(format!("{name} produced no output"));
    }
    if write_failed {
        return Err(format!("{name} did not read the whole buffer"));
    }
    Ok(formatted)
}

/// Reformat `text` as the file at `path`, using the first formatter installed
/// for its type.
///
/// `async` like every other command that shells out: the formatter is a process
/// and `wait_with_output` blocks until it finishes, which on a large file is long
/// enough to freeze the UI.
#[tauri::command(async)]
pub fn format_text(path: String, text: String) -> Result<Formatted, String> {
    let file = Path::new(&path);
    let extension = file
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();
    let candidates = candidates_for(&extension);
    if candidates.is_empty() {
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned());
        return Err(match name {
            Some(name) if extension.is_empty() => format!("no formatter for {name}"),
            _ => format!("no formatter for .{extension} files"),
        });
    }

    // The file's own directory, so every formatter resolves its config the way
    // it would have if the user had run it from there themselves.
    let cwd = file.parent().filter(|dir| dir.is_dir()).unwrap_or(Path::new("."));

    for candidate in candidates {
        let resolved = candidate
            .node
            .then(|| local_node_bin(cwd, candidate.bin))
            .flatten()
            .or_else(|| path_bin(candidate.bin))
            // Off macOS `child_path_dirs` is empty and the inherited PATH is the
            // right one, so the bare name is the last resort rather than a
            // failure — the OS looks it up exactly as a shell would.
            .unwrap_or_else(|| PathBuf::from(candidate.bin));
        if resolved.components().count() > 1 && !resolved.is_file() {
            continue;
        }
        let args: Vec<String> = candidate
            .args
            .iter()
            .map(|arg| match *arg {
                "{path}" => path.clone(),
                "{edition}" => rust_edition(cwd),
                other => other.replace("{path}", &path),
            })
            .collect();
        let formatted = match run(&resolved, &args, cwd, &text) {
            Ok(formatted) => formatted,
            // Not installed after all — a bare name the OS could not find. Any
            // other failure is the formatter's opinion of the buffer and is the
            // answer, so it is not walked past.
            Err(message) if message.starts_with("failed to run ") => continue,
            Err(message) => return Err(message),
        };
        let formatted = strip_stdin_header(&formatted).to_string();
        return Ok(Formatted {
            changed: formatted != text,
            text: formatted,
            formatter: candidate.bin.to_string(),
        });
    }

    // Nothing installed. JSON is the one type that does not need anything to be,
    // so it is re-indented here rather than refused.
    if JSON_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()) {
        let formatted = reindent_json(&text)?;
        return Ok(Formatted {
            changed: formatted != text,
            text: formatted,
            formatter: "built-in JSON".to_string(),
        });
    }

    let looked: Vec<&str> = candidates.iter().map(|c| c.bin).collect();
    // Named so the message is something to act on: "no formatter" says nothing
    // about which one to install, and the install is the whole fix.
    let hint = if candidates.iter().any(|candidate| candidate.node) {
        format!(" — install one in the repo (`npm i -D {}`) or on your PATH", looked[0])
    } else {
        String::new()
    };
    Err(format!(
        "no formatter installed for .{extension}: looked for {}{hint}",
        looked.join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Per-test scratch directory, removed and recreated so a rerun starts clean.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mangouste-format-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn the_table_is_keyed_by_extension() {
        assert_eq!(candidates_for("ts")[0].bin, "prettier");
        // Case comes from the filename, which says nothing about the language.
        assert_eq!(candidates_for("TS")[0].bin, "prettier");
        assert_eq!(candidates_for("rs")[0].bin, "rustfmt");
        assert!(candidates_for("bin").is_empty());
        assert!(candidates_for("").is_empty());
    }

    #[test]
    fn an_unclaimed_extension_is_refused_by_name() {
        let error = format_text("/tmp/thing.bin".into(), "x".into()).unwrap_err();
        assert!(error.contains(".bin"), "{error}");
        // A file with no extension is named, since ".{extension} files" would
        // read as a stray dot.
        let error = format_text("/tmp/Makefile".into(), "x".into()).unwrap_err();
        assert_eq!(error, "no formatter for Makefile");
    }

    /// The repo's pinned tool beats a global install of the same name, and a
    /// package deep in a workspace still finds the root's.
    #[test]
    #[cfg(unix)]
    fn a_local_node_bin_is_found_up_the_tree() {
        let dir = scratch("nodebin");
        let bin = dir.join("node_modules/.bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("prettier"), "#!/bin/sh\n").unwrap();
        let deep = dir.join("packages/web/src");
        std::fs::create_dir_all(&deep).unwrap();

        assert_eq!(local_node_bin(&deep, "prettier"), Some(bin.join("prettier")));
        assert_eq!(local_node_bin(&deep, "biome"), None);
    }

    #[test]
    fn the_edition_comes_from_the_nearest_manifest() {
        let dir = scratch("edition");
        let src = dir.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            dir.join("Cargo.toml"),
            "[package]\nname = \"x\"\nedition = \"2024\"\n",
        )
        .unwrap();
        assert_eq!(rust_edition(&src), "2024");

        // No manifest anywhere: 2015 is rustfmt's own default and would mangle
        // any crate written this decade, so the guess has to be a modern one.
        let bare = scratch("edition-bare");
        assert_eq!(rust_edition(&bare), "2021");
    }

    /// The header is not Rust, and leaving it in would break the buffer it was
    /// pasted into.
    #[test]
    fn the_stdin_header_is_dropped() {
        assert_eq!(strip_stdin_header("stdin:\n\nfn main() {}\n"), "fn main() {}\n");
        assert_eq!(strip_stdin_header("fn main() {}\n"), "fn main() {}\n");
        assert_eq!(strip_stdin_header("stdin: 1\n"), "stdin: 1\n");
    }

    /// The three answers a formatter can give, stood in for by `sh`: one that
    /// agrees with the buffer, one that refuses it, and one that exits happy
    /// having said nothing.
    ///
    /// `/bin/sh` and nothing else, because it is the one path POSIX actually
    /// promises. This test reached for `/bin/true` and `/bin/false` first, which
    /// exist on Linux and do not on macOS — they live in `/usr/bin` there — so
    /// it passed everywhere it was written and failed on one CI leg.
    #[test]
    #[cfg(unix)]
    fn a_run_pipes_the_buffer_through() {
        let sh = Path::new("/bin/sh");
        let script = |source: &str| vec!["-c".to_string(), source.to_string()];
        let dir = scratch("run");
        let text = "one\ntwo\n";
        assert_eq!(run(sh, &script("cat"), &dir, text).unwrap(), text);

        let refused = run(sh, &script("exit 1"), &dir, text).unwrap_err();
        assert!(refused.contains("exited"), "{refused}");

        // An empty answer to a non-empty buffer would empty the editor. This one
        // also never reads stdin, so the write fails with EPIPE or not depending
        // on whether the buffer fitted in the pipe first — the empty output is
        // the answer either way, which is what `run` orders its checks for.
        let emptied = run(sh, &script("exit 0"), &dir, text).unwrap_err();
        assert!(emptied.contains("produced no output"), "{emptied}");
        // …but an empty buffer legitimately formats to an empty one.
        assert_eq!(run(sh, &script("exit 0"), &dir, "").unwrap(), "");
    }

    #[test]
    fn json_is_re_indented_without_a_formatter() {
        let formatted =
            reindent_json("{\"a\":1,\"b\":[1,2,{\"c\":true}],\"d\":{},\"e\":[]}").unwrap();
        assert_eq!(
            formatted,
            concat!(
                "{\n",
                "  \"a\": 1,\n",
                "  \"b\": [\n",
                "    1,\n",
                "    2,\n",
                "    {\n",
                "      \"c\": true\n",
                "    }\n",
                "  ],\n",
                // Empty containers are values, not blocks.
                "  \"d\": {},\n",
                "  \"e\": []\n",
                "}\n",
            )
        );
        // Idempotent, which is what makes it safe to run on save-shaped edits.
        assert_eq!(reindent_json(&formatted).unwrap(), formatted);
    }

    /// The reason this is a re-indenter and not a `serde_json` round trip: keys
    /// keep their order, and every scalar is the bytes it was written as.
    #[test]
    fn json_tokens_survive_verbatim() {
        let source = "{\"z\":1e400,\"a\":-0,\"s\":\"\\u00e9 \\\" {not:code}\",\"n\":null}";
        let formatted = reindent_json(source).unwrap();
        let keys: Vec<&str> = formatted
            .lines()
            .filter_map(|line| line.trim().split(':').next())
            .filter(|token| token.starts_with('"'))
            .collect();
        assert_eq!(keys, ["\"z\"", "\"a\"", "\"s\"", "\"n\""], "keys were reordered");
        assert!(formatted.contains("1e400"), "{formatted}");
        assert!(formatted.contains("-0,"), "{formatted}");
        assert!(formatted.contains("\\u00e9 \\\" {not:code}"), "{formatted}");
    }

    /// jsonc and json5 are what tooling configs are written in, so a comment or a
    /// trailing comma has to come out the other side.
    #[test]
    fn json_keeps_comments_and_trailing_commas() {
        let formatted = reindent_json("{// why\n\"a\":1, /* and */ \"b\":2,}").unwrap();
        assert_eq!(
            formatted,
            "{\n  // why\n  \"a\": 1,\n  /* and */\n  \"b\": 2,\n}\n",
            "{formatted}"
        );
        // json5: unquoted keys and single quotes are tokens like any other.
        assert_eq!(reindent_json("{a:'x'}").unwrap(), "{\n  a: 'x'\n}\n");
    }

    /// Refused rather than mangled. A formatter that half-understands its input
    /// and writes anyway is worse than one that declines.
    #[test]
    fn json_that_is_not_json_is_refused() {
        for source in [
            "{\"a\": \"unterminated}",
            "{\"a\": 1]",
            "{\"a\": 1",
            "[1 2]",
            "{\"a\": /* unterminated",
        ] {
            assert!(reindent_json(source).is_err(), "accepted {source:?}");
        }
        // An empty file has nothing to indent, and must not become a newline.
        assert_eq!(reindent_json("").unwrap(), "");
        assert_eq!(reindent_json("\n\n").unwrap(), "\n\n");
    }

    /// Rewriting every line ending is not a formatting change anyone asked for.
    #[test]
    fn json_keeps_the_line_endings_it_arrived_with() {
        assert_eq!(reindent_json("{\r\n\"a\":1}").unwrap(), "{\r\n  \"a\": 1\r\n}\r\n");
    }

    /// Same bytes in, same JSON out. The indenter is not allowed to change what
    /// the file *means*, which is the one thing token-copying is supposed to buy.
    #[test]
    fn json_keeps_its_meaning() {
        let source = concat!(
            r#"{"deps":{"b":"^1.0.0","a":"~2"},"list":[[],[{}],[1,[2,[3]]]],"#,
            r#""text":"a:b, {c} [d] \"e\" \\","empty":{},"t":[true,false,null],"#,
            r#""num":[0,-0,1.5e-9,12345678901234567890]}"#
        );
        let formatted = reindent_json(source).unwrap();
        let before: serde_json::Value = serde_json::from_str(source).unwrap();
        let after: serde_json::Value = serde_json::from_str(&formatted).unwrap();
        assert_eq!(before, after, "{formatted}");
    }

    /// Every JSON file in this checkout, which is the only corpus to hand that
    /// nobody wrote for this test — `package-lock.json` alone is 100KB of shapes
    /// no fixture would have thought of. Ignored: it reads the working tree.
    ///
    /// `cargo test --lib format -- --ignored`
    #[test]
    #[ignore]
    fn json_survives_every_file_in_the_repo() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let mut checked = 0;
        for entry in ignore::WalkBuilder::new(&root).hidden(false).build().flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            let Ok(source) = std::fs::read_to_string(path) else {
                continue;
            };
            let Ok(before) = serde_json::from_str::<serde_json::Value>(&source) else {
                continue; // not strict JSON; the indenter is not the validator
            };
            let formatted =
                reindent_json(&source).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            let after: serde_json::Value = serde_json::from_str(&formatted)
                .unwrap_or_else(|e| panic!("{} became invalid: {e}", path.display()));
            assert_eq!(before, after, "{} changed meaning", path.display());
            assert_eq!(
                reindent_json(&formatted).unwrap(),
                formatted,
                "{} is not stable under a second pass",
                path.display()
            );
            checked += 1;
        }
        eprintln!("{checked} json files");
        assert!(checked > 0, "no json files found under {}", root.display());
    }

    /// The command falls back to the built-in only after the installed formatters
    /// have been looked for, and says which one to install when there are none.
    #[test]
    fn json_falls_back_to_the_built_in() {
        let dir = scratch("json-fallback");
        let path = dir.join("thing.json").to_string_lossy().into_owned();
        let formatted = format_text(path, "{\"a\":1}".into()).unwrap();
        // Only meaningful on a machine with no prettier on its PATH; where there
        // is one, prettier answers and the assertion below still holds.
        assert!(formatted.text.contains("\"a\": 1"), "{:?}", formatted.text);
        assert!(formatted.changed);

        // `x` is not Rust, so this refuses either way — with rustfmt's own parse
        // error where rustfmt is installed, and with the advice to install it
        // where it is not. Both have to name rustfmt: the machine running the
        // tests decides which branch is taken, and an unattributed `error:
        // expected one of ...` in the editor names neither the formatter nor the
        // fact that one ran.
        let message = format_text(dir.join("a.rs").to_string_lossy().into_owned(), "x".into())
            .expect_err("x is not Rust");
        assert!(message.contains("rustfmt"), "{message}");
    }

    /// The whole path, through a formatter that is really installed. Ignored by
    /// default: what is on the machine decides whether it can run at all, and a
    /// test that quietly passes when the tool is missing proves nothing.
    ///
    /// `cargo test --lib format -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn formats_a_go_buffer_with_the_real_gofmt() {
        let dir = scratch("gofmt");
        let path = dir.join("main.go").to_string_lossy().into_owned();
        let formatted =
            format_text(path, "package main\nfunc main(){x:=1;_=x}\n".into()).expect("gofmt");
        eprintln!("{}\n{:?}", formatted.formatter, formatted.text);
        assert_eq!(formatted.formatter, "gofmt");
        assert!(formatted.changed);
        assert!(formatted.text.contains("func main() {"), "{:?}", formatted.text);
    }

    /// A buffer bigger than a pipe buffer, which is what the writer thread is
    /// for: a single-threaded write would block here and never be read.
    #[test]
    #[cfg(unix)]
    fn a_buffer_larger_than_the_pipe_survives() {
        let dir = scratch("big");
        let text = "abcdefgh\n".repeat(40_000); // ~350KB, well past a 64KB pipe
        // Through `sh` for the same reason as the test above: `/bin/sh` is the
        // one path every unix promises, and a test binary that is only on some
        // of them fails on a machine nobody ran it on.
        let args = vec!["-c".to_string(), "cat".to_string()];
        assert_eq!(run(Path::new("/bin/sh"), &args, &dir, &text).unwrap(), text);
    }
}
