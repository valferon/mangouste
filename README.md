<img src="src-tauri/icons/source/mongoose.svg" alt="mangouste" width="96">

# mangouste

A lightweight watcher and coordinator for many concurrent Claude Code sessions.
Single-window and multi-repo, so it also replaces running one VSCode window per
repository — but the reason it exists is the *n* sessions, not the one window.
A second window is `Ctrl+Shift+N` when one screen is not enough; it is the same
process, watching the same sessions.

```
┌───────────────────────────────────────────────────────────────────────┐
│ (m) File Edit View Terminal Help   [ payments-service Ctrl+P ]        │
├───┬──────────────┬─────────────────────────────────┬──────────────────┤
│ E │ Explorer     │ Chat │ file.ts │ a1b2c3 …       │ Current session  │
│ F │  file tree   ├─────────────────────────────────┤  model · branch  │
│ G │  src/        │                                 │  context · spend │
│ H │  README.md   │  stream-json chat with          │                  │
│   │              │  the claude CLI                 │ Sessions  3 live │
│   │              │                                 │  ● playground    │
│   │              ├─────────────────────────────────┤  ○ web-app       │
│   │              │ Terminal      Ctrl+`            │  ● payments-svc  │
│   │              │ $                               │     2 agents     │
├───┴──────────────┴─────────────────────────────────┴──────────────────┤
│ ~/workspace/payments-service   session a1b2c3   idle      7 repos     │
└───────────────────────────────────────────────────────────────────────┘
```

`E`, `F`, `G` and `H` are the activity rail — Explorer, Find, Source Control,
Git History: one left view at a time, switched with `Ctrl+Shift+E` /
`Ctrl+Shift+F` / `Ctrl+Shift+G` / `Ctrl+Shift+H`, and the button for the open
view collapses it. All four stay mounted — glancing at the tree must not throw
away a half-typed commit message, the results of a sweep that took seconds, or
a page of history scrolled back through the year.

## What it is for

Running `claude` is not the problem; the CLI does that fine. Running eight of
them across six repos and knowing which one wants you — that is the problem.

So the assumption behind every pane here is *n* sessions in flight, most of them
unattended at any moment:

- **The Sessions rail is the watch surface**, not a nav tree. Every session in
  `~/.claude/projects` on one screen, one line each, grouped by repo and ordered
  by real conversational activity. The status column is the whole point:
  `awaiting` is blocked on you, `pendingReview` finished while you were looking
  elsewhere, `interrupted` went quiet mid-turn. See
  [Sessions sidebar](#sessions-sidebar) for how each is decided.
- **Fan-out stays visible.** Subagents and Workflow runs nest under their session
  and hold it active, because a fanned-out session writes nothing to its own
  transcript for minutes at a time and a naive reader calls that finished.
- **Sessions this window did not start still count.** The rail reads the
  transcripts on disk, so a `claude` in a bare terminal, or one from last week,
  sits in the same list as the panes here.
- **Nothing unmounts when hidden.** A turn keeps streaming in a chat tab you are
  not looking at, an unsaved buffer survives a tab switch, and each repo's shells
  keep their scrollback while another repo is in front.
- **Steering is one keystroke from watching.** Same window, so answering an
  `awaiting` session, reading its diff, and running the command it suggests do not
  cost three context switches. `Ctrl+P` to the repo, `Ctrl+N` for a new session,
  `Ctrl+\`` for its terminal — or Settings ▸ Sessions run in ▸ `terminal`, and the
  session tab holds `claude` itself instead of this app's pane.

Coordinating here means reading and steering, not automating. No rule engine
answers a prompt for you and no scheduler decides what runs next — the watcher
tells you which session to look at, and the workbench makes the next move cheap.

## Requirements

Node 24, as pinned in `.nvmrc`. Ubuntu's own `node` is 18, which the Vite build
refuses, so this is the one prerequisite that fails with a version error rather
than a missing-package error:

```bash
nvm use    # or nvm install, the first time
```

Rust (via rustup) and the WebKitGTK toolchain:

```bash
sudo apt update && sudo apt install -y \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf
```

On macOS, Rust (via rustup) and the Xcode command line tools
(`xcode-select --install`) are the whole list — the webview is the system's.

`claude` must be on PATH, or at one of the probed locations
(`~/.local/bin`, `~/.claude/local`, `~/.bun/bin`, `~/.volta/bin`,
`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`). Override with
`MANGOUSTE_CLAUDE_BIN`. On macOS the search starts from the PATH the *login
shell* reports rather than the one the app inherited — see
[Platforms](#platforms).

## Run

```bash
npm install
npm run app          # tauri dev
npm test             # vitest, frontend
npm run app:build    # deb + AppImage in src-tauri/target/release/bundle
```

`cargo test` in `src-tauri` covers the Rust side. CI runs both before bundling.

A locally built `.deb` will not install until its `Depends` is repaired — Tauri
appends its own hardcoded `libgtk-3-0`, which has no candidate on Ubuntu 24.04.
CI does this step; `app:build` does not:

```bash
./scripts/fix-deb-depends.sh src-tauri/target/release/bundle/deb/*.deb
```

## Platforms

Linux is the primary target and the only one built locally by `app:build`. CI
builds it for both x86_64 and arm64, each on a native runner.

macOS builds on CI (`.github/workflows/build.yml`, `macos-14`) as a single
universal `.dmg`: the runner is Apple Silicon and its Xcode carries both SDK
slices, so the Intel half is a cross-compile. Tests run native arm64, because
`universal-apple-darwin` is a Tauri pseudo-target that `cargo test --target`
will not accept.

### Installing on macOS

```bash
curl -fsSL https://raw.githubusercontent.com/valferon/mangouste/main/scripts/install-macos.sh | bash
```

`| bash`, not `| sh`. Re-run it to update; it skips the work when the installed
version already matches, and `--force` reinstalls anyway. The app tells you when
there is something to re-run it for — see [Knowing there is a newer
mangouste](#knowing-there-is-a-newer-mangouste).

That one command exists because of a single extended attribute. A browser
attaches `com.apple.quarantine` to a download; Gatekeeper then assesses the app,
finds no notarization, and the *kernel* refuses to execute it — the icon bounces
and nothing starts, with `AppleSystemPolicy: Security policy would not allow
process` in the system log. The verdict is cached against the binary's cdhash, so
clearing the flag afterwards does not reopen it. `curl` attaches no such flag, so
fetching the image from a script sidesteps the assessment entirely and the app
launches the way a locally built one does.

Dragging the `.dmg` from a browser download still works, but only with the
ceremony the script exists to avoid: `xattr -cr /Applications/mangouste.app`
*before* the first launch, and if it has already been refused once,
`codesign --force --deep --sign -` to change the hash the denial was cached
against.

Notarization is the real fix — a stapled build opens by double-click with no
terminal involved — and it needs an Apple Developer ID, six repo secrets, and
nothing else: Tauri's bundler signs and staples when they are present.

### Signing

The `.dmg` is ad-hoc signed (`signingIdentity: "-"`) but not notarized. Ad-hoc
is not cosmetic on Apple Silicon: an arm64 binary with no valid signature is
killed on launch rather than warned about, so CI asserts the signature exists
before the artifact is uploaded. Notarization it does not have, so Gatekeeper
still quarantines the download:

```bash
xattr -cr /Applications/mangouste.app
```

The hardened runtime is off (`hardenedRuntime: false`), against Tauri's default.
It is not a hardening on an ad-hoc signature: AMFI enforces library validation
and JIT restrictions against a signature with no team identity, the bundle
cannot be notarized regardless, and it blocks `sample` and `lldb` from reading
the process — which is the only way to diagnose a launch that draws no window.
CI asserts the flag stays off.

`MANGOUSTE_TRACE_STARTUP=1` prints a line per startup phase to stderr, which is
what to reach for when a launch hangs before its window:

```bash
MANGOUSTE_TRACE_STARTUP=1 /Applications/mangouste.app/Contents/MacOS/mangouste
```

Whether any line appears at all separates a wedged phase from a process that
never reached `main`.

Four things are macOS-specific rather than shared, and each is a real difference
in the platform rather than a shim:

- **PATH.** A windowed launch inherits `/usr/bin:/bin:/usr/sbin:/sbin` and
  nothing else, so Homebrew, nvm, bun and `~/.local/bin` are all invisible to a
  double-clicked app while being on the PATH of every terminal on the machine.
  Worse than a missing `claude`: the CLI is a node script, so finding it by
  absolute path still fails when its `#!/usr/bin/env node` cannot resolve
  `node`. `src-tauri/src/env.rs` asks `$SHELL -ilc` for its PATH once, in the
  background at startup, and hands that to every child — `claude` and `git`
  both. `-ilc` rather than `-lc` because zsh only reads `.zshrc` when
  interactive, and `.zshrc` is where Homebrew's own installer tells people to
  put their PATH.
- **The menu bar.** A WKWebView gets ⌘C/⌘V/⌘Z from a native Edit menu's items,
  not from the webview, so an app without one cannot copy or paste at all. Tauri
  installs a default menu for exactly this reason, but its File and Window
  submenus both carry Close Window — and closing the only window kills every
  `claude` this process owns. `mac_menu` in `lib.rs` replaces it with the same
  editing and window items and no Close Window, leaving ⌘W to close a tab.
- **The keymap.** Ctrl becomes Cmd, once, where the chord table is built; see
  [Keybindings](#keybindings).
- **Credentials.** The CLI keeps its OAuth token in the login keychain on macOS,
  not in `~/.claude/.credentials.json`, so `usage.rs` reads it with `security
  find-generic-password -s "Claude Code-credentials"` and falls back to the file.
  The first read raises the system's own access prompt; answering *Always Allow*
  is what makes it silent from then on.

Selecting text still does not publish to PRIMARY there, because PRIMARY is an
X11 selection with no macOS equivalent — `primary.rs` compiles to inert stubs
and the frontend bridge does not install. Middle-click still closes a tab; it
just pastes nothing.

One thing remains unverified on real hardware: the "waiting on" line under a
running turn reads the process group from `/proc` on Linux and from `ps`
elsewhere, and the `ps` path is unit-tested but has never run on a Mac.

Windows is not supported and is not built. The Rust side is Unix-only in about
two dozen places -- process groups and signals for tearing down a `claude`
process tree, mode bits and uid in the workspace writer -- and those are
semantic gaps rather than missing shims: Windows has no process groups and no
mode bits, so the behaviour has to be redesigned, not ported.

## Icon

`src-tauri/icons/source/mongoose.svg` is the whole thing: launcher icon, titlebar
mark, and the image at the top of this file. The path is the one `MongooseLogo`
draws in `src/lib/icons.tsx`, lifted out of its 24-unit box — edit both or
neither. Filled rather than stroked, on a dark plaque rather than bare, because
both decisions are what let it survive being drawn at 32 px in a dock and at
`currentColor` against an unknown page background.

Regenerate every raster size from it:

```bash
convert -background none src-tauri/icons/source/mongoose.svg -resize 1024x1024 /tmp/icon.png
npx tauri icon /tmp/icon.png
```

`mangouste.svg` beside it is the previous mark — the three-pane workbench, one
amber node in the sessions rail. Nothing consumes it now; it is kept because it
is the better drawing of what the app *does*, if the animal ever wears thin.

The dock shows a generic gear under `npm run app`: a `tauri dev` window has no
`.desktop` file, so the shell cannot map the window to an application and falls
back. The bundled `.deb`/AppImage carries one and shows the real icon. To get it
in dev too, register a hidden entry keyed on the window's class:

```bash
install -Dm644 src-tauri/icons/icon.png \
  ~/.local/share/icons/hicolor/256x256/apps/mangouste.png
cat > ~/.local/share/applications/mangouste-dev.desktop <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=mangouste (dev)
Icon=mangouste
Exec=false
NoDisplay=true
StartupWMClass=mangouste
DESKTOP
update-desktop-database ~/.local/share/applications
```

`WM_CLASS` on the dev window is `"mangouste", "Mangouste"`, so `StartupWMClass`
takes the instance name above. Confirm with `xprop WM_CLASS` if that ever
changes — a mismatch fails silently rather than falling back.

## Architecture

Rust owns every process and filesystem interaction; the webview is pure UI.

| Module | Responsibility |
| --- | --- |
| `src-tauri/src/claude.rs` | One `claude` child per chat pane over stream-json |
| `src-tauri/src/pty.rs` | PTY-backed terminals (`portable-pty`), base64 on the wire |
| `src-tauri/src/sessions.rs` | Scans `~/.claude/projects`, head/tail sampled |
| `src-tauri/src/git.rs` | `git` porcelain: status, tracking, log, show, diff |
| `src/lib/editorFacts.ts` | Caret, EOL, indent and language, in a store of their own |
| `src-tauri/src/workspace.rs` | Repo discovery, lazy tree, quick-open search |
| `src-tauri/src/format.rs` | Buffer through the repo's own formatter, stdin to stdout |
| `src-tauri/src/primary.rs` | X11 PRIMARY + CLIPBOARD access |
| `src-tauri/src/chats.rs` | Owns the child processes; kills them with their window |
| `src-tauri/src/windows.rs` | A second window on the same process, and its label |
| `src-tauri/src/permission.rs` | The MCP server the CLI asks for tool approval |
| `src-tauri/src/stats.rs` | Corpus-wide tokens and cost, resumed by byte offset |
| `src-tauri/src/usage.rs` | Anthropic usage windows, opt-in |

### Chat transport

Each chat pane spawns:

```
claude --print --verbose \
       --input-format stream-json --output-format stream-json \
       --include-partial-messages \
       [--resume <uuid>] [--permission-mode <mode>]
```

User turns are written to stdin as NDJSON. Every stdout line is forwarded to the
frontend verbatim on `claude://message`, so message types this build does not
model still reach the UI rather than being dropped.

### Sessions sidebar

Session files are never read whole — 32 KB from the head supplies `cwd`,
`version` and the fallbacks for `gitBranch` and the title, 128 KB from the tail
supplies the title, last prompt, and the status inputs. Title records are
written once and never re-appended, so a long session's only one sits outside
both samples unless the head is consulted; when a single record is larger than
the tail sample, the tail is re-read as whole lines instead. Parsed results are
cached by `(path, mtime, size)`, so a filesystem event re-parses one transcript
rather than all of them.

Status is a port of the state machine in
[session-control-center](https://github.com/valferon/session-control-center)
(`computeStatus` in `src/data/jsonlParser.ts`):

| Status | Meaning |
| --- | --- |
| `active` | A turn is in flight, or queued prompts / subagents are still working |
| `awaiting` | Ended on `AskUserQuestion` or `ExitPlanMode` — blocked on you |
| `pendingReview` | Ended cleanly, but you have not looked at it since |
| `finished` | Ended cleanly and you have seen it |
| `interrupted` | Went quiet mid-turn: ESC, dead window, or an API error |
| `idle` | Nothing for over 24 h, and nothing above claimed it |

`awaiting` and `interrupted` are decided before the recency windows, so neither
ages into `idle`. A question nobody answered is still unanswered a week later,
and a turn that was cut off is still the reason the session stopped; collapsing
either into `idle` reports the clock and drops the outcome, and `idle` rows are
hidden in the rail by default. Dismissing one of those rows is what archiving is
for — a decision, not a timeout. Everything else does age out: nothing is in
flight and nothing is owed.

`pendingReview` never comes off the wire. Rust reports `finished` and the
seen-store overlay rewrites it, exactly as the extension does — see below.

Windows: active 5 min, idle 24 h, and a 30 min grace for an unanswered
`tool_use` — tool calls append nothing while they run, so a shorter window
mislabels long builds and agent fan-outs as interrupted. `system` records only
move the activity watermark for the two subtypes that prove a turn is in flight
(`api_error`, `model_refusal_fallback`); a whitelist, because `away_summary`
lands minutes after the turn and would drag the watermark past its end.

Statuses only downgrade once the transcript has been quiet for 10 s. At the
instant `end_turn` is the tail of the file the next record is milliseconds away —
or mid-write, and skipped as a partial line — so a scan landing there computes
`finished` for a session that never stopped. The pane's 15 s poll always outlasts
the grace, which is what re-evaluates a held status.

### Sidechain probe

Subagents write only their own logs while the main transcript sits at a clean
turn end, so the probe is what keeps a fanned-out session from reading as
finished. Two levels are scanned, because Workflow-tool agents live a level
deeper than Agent-tool ones and a flat read misses them entirely:

```
<projectDir>/<sessionId>/subagents/agent-*.jsonl              Agent tool
<projectDir>/<sessionId>/subagents/workflows/<runId>/agent-*.jsonl   Workflow tool
<projectDir>/<sessionId>/workflows/<runId>.json               run record
```

An agent counts as running when its log was written inside the active window,
except when its `<id>.meta.json` says `stoppedByUser` — a killed agent's fresh
mtime is only its final flush. `journal.jsonl` in a run directory records the run,
not an agent, so only `agent-*` logs are read. A run whose record carries a
terminal status is skipped whole: its agents' last writes are the final flush, and
counting them held the session active for a full window after the workflow ended.
Workflow agent metas carry no description, so the run record's `workflowProgress`
labels supply them.

Probes are keyed separately from the parse cache — a parse is stale when the
transcript moves, a probe when its 10 s TTL expires — and skipped entirely for
sessions past the idle window.

Rows are one line each: status glyph, title, heat badge, age. Everything else —
branch, message count, full id, exact status — is in the row tooltip, because the
rail is ~300px and the pane earns its keep by showing every session at once.
Running agents and workflow runs nest under their session, open by default while
anything is writing.

A repo you opened but never talked to gets a header row too, with nothing under
it. The rail is built out of transcripts, so reading code in a tree without
starting a session there used to leave no trace of it at all: switch away and the
only way back is the repo picker. Visits are remembered in `src/lib/visitedRepos.ts`
— a `localStorage` list of paths and when each was last shown, capped at 40 —
and a visited repo the scan cannot account for is drawn dimmed, badged with its
age instead of a status summary, over a row that starts a session there. Where
the scan did find sessions and the standing filters are hiding all of them, that
row says so and clicking it turns the idle filter on. Visits age out on the same
24 h line that makes a session `idle`, so one retention rule covers both, and
*Forget this Repo* in the row's menu drops one early. `onlyLive` is the one
toggle a visited row cannot pass — nothing is running in a repo with no sessions.

The badge column is a recency ramp (`■ ▪ ▫` at 20 / 120 / 480 min), keyed on the
conversational watermark rather than mtime. A size ramp, not a colour one: three
colour steps at 10px are indistinguishable, and the badge slot has no alignment
to protect. Reviewed-and-quiet sessions grey out, except the five you checked
most recently, which stay green so your working set does not sink into that tail
— rank-based, so a quiet hour does not fade it and a busy burst does not light up
a dozen rows.

Read and archive state is a `localStorage` overlay in `src/lib/sessionStore.ts`,
not a fact about the transcript, so archiving a row writes nothing to disk. Each
session's mark holds three fields: the watermark you were shown, a monotonic clock
of when you were shown it, and an `unread` stamp set by "mark unread" that wins
while it is above that clock. A session is reviewed when
`lastActivityMs <= w && unread <= seenAt`, and a `finished` session that is not
reviewed renders as `pendingReview`.

The watermark is the conversational one, never mtime: opening a session rewrites
its log without adding conversation, and title regeneration and history snapshots
bump mtime too. Marks made because a session's pane is open are `passive` and
leave an explicit "mark unread" standing; only a deliberate open clears it.

The overlay is shared through `SessionFlagsProvider`, so the rail, the status
panel and the counts cannot form separate opinions about the same row. Archived
rows are hidden until the archive toggle asks for them, and never contribute to
the header counts.

The two states that are still moving — `active` and `awaiting` — animate their
glyph ring; the other three are still. Opacity is the animated property because
WebKitGTK will not reliably animate `r` or a transform on an SVG child. The whole
thing stops under `prefers-reduced-motion`.

Not ported: the `pendingReview` state itself. The seen-store it needs now exists,
but nothing yet distinguishes "changed since you looked" from "wants review".

A `notify` watcher on `~/.claude/projects` pushes `sessions://changed`; a 15 s
interval covers status decay, which is time-based rather than event-based.

### Editor

The file viewer is an editor: a textarea, a gutter, and a highlight layer painted
underneath it, so selection, the caret and the native undo stack are never
reimplemented. The interesting problem is not the editing but the second writer —
claude is editing the same tree — so the mtime the bytes were read at rides along
with every save and a write that would clobber someone else's change is refused.
That leaves three answers to a conflict, and the pane offers all three: reload and
lose yours, overwrite anyway, or keep editing.

`Shift+Alt+F` reformats the buffer with whatever formatter the repo already uses
— prettier out of the repo's own `node_modules/.bin` before any global one, then
biome or dprint; rustfmt at the crate's edition; gofmt, ruff or black, taplo,
stylua, shfmt, clang-format. Nothing is configured here: each of these reads its
rules from the repo it is run in, so the style is the one the repo already gives
its own tooling, and a repo with none installed is told which to install rather
than restyled by whatever happened to be on the machine.

JSON is the exception and the only thing bundled — an editor that cannot
pretty-print a `package.json` until someone installs a node toolchain has a hole
in it. It runs only when nothing else is installed, and it is a *re-indenter*: the
tokens are copied out byte for byte and only the whitespace between them is
rewritten. A round trip through `serde_json::Value` would sort every object's
keys, renormalise numbers and rewrite escapes, so `1e400`, `-0` and the order of
`dependencies` would all come back changed. Comments and trailing commas pass
through for jsonc and json5; anything not JSON-shaped is refused with a line and
column rather than mangled.

Text in, text out — `format_text` pipes the buffer through the formatter's stdin
and takes stdout back, and nothing is written to disk on the way. Both halves of
that matter: an unsaved draft can be formatted at all, and the mtime a save has
to carry is still the one the file was read at, so the guard above is untouched.
The result is applied through the textarea rather than by replacing its value, so
`Ctrl+Z` takes the format back — a format that cannot be undone is one nobody
runs on a file they care about.

Tabs never unmount for the same reason: hiding is not unmounting, so switching
tabs cannot silently drop an unsaved buffer, and closing one asks before it does.

Chat tabs do retire themselves, though — a strip is not a filing cabinet.
`src/lib/tabRetire.ts` decides which: a chat whose session has been quiet for two
days, or one whose session you archived, closes without asking. Two days rather
than one because a session picked up the next morning is still the one you were
working on. The clock is the conversational watermark, so a tab is not kept alive
by having been glanced at. Nothing in flight is touched — `active`, `awaiting` and
`pendingReview` outrank the clock, along with the tab in front and anything
pinned — and the sweep rides the rail's own scan rather than a timer of its own,
which is why a window left up overnight does not re-accumulate what the last one
cleared. This is also the app's standing cost, not only its clutter: every repo's
panes stay mounted on purpose, and each mounted chat is a listener on every frame
its session streams.

The strip belongs to the repo in front. A tab — a chat, a file, a diff — is owned
by the repo it was opened from and only appears in that repo's strip, so switching
to `payments-service` does not put six unrelated files from three other repos in
front of you. Hidden is still not unmounted: the other repos' panes stay in the
tree, keeping their streams and their unsaved buffers, exactly as they do across
an ordinary tab switch. The dashboard is the one tab with no repo, deliberately —
it is a cross-repo watch surface, and clicking a row on it *switches repo*, so a
dashboard owned by one would hide itself the moment it was used. A file reopened
from a second repo moves rather than clones, because one path is one editor: two
buffers over one file would mean two undo stacks and two savers racing the same
mtime guard.

The strip itself survives a relaunch: the open tabs are persisted as they change
and come back on the next start (Settings can turn this off). Chat tabs come
back *cold*, the way Firefox restores a window — the tab sits in the strip under
its name, but the `claude` process is not spawned and the transcript is not read
until the first time you open it. Restoring eight tabs eagerly would mean eight
CLI processes and eight transcript reads at boot, most of them for tabs you
wanted to keep, not resume. Two kinds of tab do not come back: diff tabs, whose
patch is derived output that would otherwise sit whole in `localStorage`, and
"New session" tabs that never got a session id — with no session to resume and
no transcript to render, restoring one would be a blank pane pretending to be
history.

### Find and replace

`Ctrl+Shift+F` is the third rail view: a query, a replacement, the three matcher
toggles (`Aa`, `ab`, `.*`) and the include/exclude glob boxes, over results
grouped by file. It sweeps the active repo through the same `ignore` walk the
Explorer draws and the same reader the editor opens through, so what a find can
reach is what you could have opened by hand — gitignored paths, binaries, and
anything over 2 MB are not in it.

Matching is per line. `^` and `$` therefore mean what they look like they mean,
and a query containing a newline finds nothing: a multi-line search is a
different feature with a different cost profile, and faking it by matching across
a whole file would make every minified bundle a hazard. The sweep is parallel and
bounded — a per-file cap, a global match cap, a file-size ceiling — because the
pane is blocked on the answer; the summary line says `capped` when the results
are a prefix rather than the whole truth.

Every match carries the byte span Rust found it at, and a replace hands those
spans back. That is what makes dismissing a match or a whole file mean something:
the write gets the spans that survived, and Rust re-runs the same matcher over
the file to prove each one is still a match before rewriting anything. The
matcher is built once from the query and the toggles that came with the request,
so what the results describe and what the write does cannot drift apart — there
is no remembered search state in the process to go stale.

Writes go through the editor's own save path, which means the same optimistic
lock: each file's replace carries the mtime the search read it at, and a file
claude rewrote in between is refused rather than clobbered. One refusal does not
cost the other files their replace — the summary names what was refused and why.
Replacing across more than one file asks first, like discarding changes in the
SCM pane does, because nothing in the app can put those files back.

`$1` in the replacement is a capture group only with `.*` on; a literal
find-and-replace of a price list must not have `$1` vanish. That is also why a
row only previews the swap for a literal replacement: a preview computed here
from a different engine than the one that will do the write would eventually lie.

Clicking a result opens the file and lands the caret on the match, selecting the
line — coming from a list of matches, seeing *which* text matched is the point.

## Where sessions run

Settings ▸ **Sessions run in** picks what a session tab holds: `app chat` (the
default) or `terminal`. Same strip, same tabs, same rail — the choice is which
program you are talking to.

The chat pane is a stream-json client. It drives `claude` over a pipe and renders
the frames itself, which is what makes the transcript view, the token and cost
counts, the phase chip and the status dots possible at all. What it is not is
`claude`: the TUI's own permission prompts, its `/` commands, its statusline and
whatever the user has built around it belong to the real terminal program. So
`terminal` puts the CLI in the tab, in a pty, where the pane would have been.

Not in the terminal panel at the bottom. That panel is for shells — a build, a
git command, a REPL — and its tabs are numbered because that is what a shell
needs. A session is not one of those, and putting it there would mean the strip
no longer shows you your sessions.

**The session is named before it starts.** `claude` in a pty reports nothing
back: there is no stream to read a uuid out of. A tab that never learns which
session it is holding can never be labelled, renamed, resumed, or matched against
a row in the rail — so the id is minted here and handed over as
`--session-id <uuid>`, and the CLI writes its transcript under it. Resuming
instead passes `--resume <uuid>`, and which of the two a tab gets is decided by
whether it has a transcript yet.

The command is typed into a login shell rather than handed to the spawn as
`$SHELL -l -c claude`, deliberately: the point of running the CLI here is that it
is running in a real terminal, so it gets the rc files, the PATH and — when it
exits — the prompt back. Only the pane's first shell is sent it, so the
`[process exited — press Enter for a new shell]` message keeps its promise.

Nothing about the CLI is second-guessed. No `--model` and no `--permission-mode`:
those two preferences exist because the pane spawns the CLI and has to hand it
flags. A terminal session is the user's own `claude`, configured the way they
configured it, which is the reason to want one.

Session ids reach a command line, so they are checked rather than trusted. They
arrive two ways — minted here, and read out of filenames under
`~/.claude/projects` — and a filename is not a shape this app gets to assume.
Anything not shaped like an id starts a fresh session in the right repo instead;
a `;` never reaches the shell.

The rest follows from the tab holding a program instead of a pane:

- **The surface is a property of the tab, not of the setting.** Every session tab
  records what it was opened with. Switching the preference decides where the
  *next* session goes; re-pointing a tab that is already holding a live process
  at a different renderer would orphan it.
- **It mounts on first activation.** A restored strip of eight terminal tabs would
  otherwise be eight ptys and eight `claude` processes at boot — the same bargain
  `cold` already strikes for panes, differing only in that a pty has nothing to do
  while it waits, so there is nothing to keep mounted until then. Once up it stays
  up, and the session keeps running while you read another tab.
- **A terminal tab is only persisted once its transcript exists.** Unlike a pane,
  its id is set from the moment it is minted, so the id is not evidence of a
  session. Restoring one without a transcript would relaunch it as `--resume`
  against something `claude` never wrote — an error message where a conversation
  should be.
- **It gets a mark, not a dot.** The status dot is read off the stream, so only a
  pane has one; a dot stuck on `idle` forever would read as a status rather than
  as the absence of one. A `❯` in its place says which program the tab holds.
- **The label still comes from the session.** Its own title once the rail has
  scanned it, and `New session` until then — an id is not a name.
- **The rail does not care.** It reads the transcripts on disk, so a session run
  in a tab's terminal sits in the same list, with the same status column, as one
  run in a pane — or one run in a terminal outside this app entirely. Renaming
  works the same way, and says so when there is no transcript to write to yet.
- **Entries written before this existed still restore.** A stored tab with no
  surface is a chat tab, which is the only surface there used to be.

## How much a session tells you

The rail at the bottom of the chat pane has a third switch, next to the model and
the permission mode: **quiet · normal · verbose**. It answers one question — how
much of the model's own account of itself you want in the transcript while the
turn is still running.

The reason it is a setting and not a fixed choice is that a session you cannot
read is a session you cannot stop. A column of collapsed `Bash` rows tells you
that work is happening and nothing about what it is *for*, so by the time a wrong
approach is legible the wrong edit has landed.

- **quiet** — the transcript as a list of actions. Reasoning folds to a
  `thought · 214 words` chip you can open. Nothing is dropped; a turn rendered
  with its reasoning deleted would read as a turn that did not reason.
- **normal** — the default. Every call is headlined with the model's own
  description of it, with the command or path to its right, and reasoning is
  inline prose.
- **verbose** — the above, plus every call's arguments and output already open,
  plus the inside of subagents.

Two of the three are decisions about frames already received and apply on the
click. Only `verbose` changes how `claude` is spawned, so only `verbose` can show
the switch as pending: it adds `--forward-subagent-text`, and there is no control
request for "start forwarding", so that half waits for a restart. The tooltip
says which half you are waiting on.

**Descriptions were already being written and thrown away.** Every `Bash` call
carries a human-written `description`, and until this switch existed it reached
only the spinner, where it lives exactly as long as the call does.
`grep -n "MAX_THINKING_TOKENS" -r src-tauri/src src` and "Check thinking env
plumbing" are the same call; only one of them answers "why". Above `quiet` the
description is the headline and the payload moves to its right.

**Thinking is not in the transcript.** This is worth knowing because it looks
like a bug in this app and is not: every thinking block is written to disk as its
signature and an empty string. Measured on this project's own logs — 193 blocks
across four transcripts, none with text. The text exists only as
`thinking_delta` events while the turn runs, which is why a resumed session used
to show a rail of tool calls with the reasoning between them silently gone. So
the pane keeps what it streams, keyed on the block's signature, and joins it back
on when history is hydrated (`lib/thinkingStore.ts`, bounded to 256KB). A block
this app never watched arrive — one written by the CLI itself, or evicted — still
renders as it always did: not at all.

**Subagent internals are otherwise invisible.** A fan-out is precisely when the
parent transcript goes quiet for minutes, because the parent writes nothing until
its agents return. At `verbose` the CLI forwards what they say and the pane
renders it indented under the spawn that caused it. Indented, and never as a
plain assistant bubble: a forwarded frame carries its own model and its own usage
and no tool call, so letting one through the main path would reset the spinner
mid-tool, overwrite the context count with a subagent's, and print a subagent's
answer as though the turn had given it.

**A turn can report itself complete and then continue.** When a background agent
reports back the CLI re-invokes itself, so one exchange emits two `result` frames
and the first one is a lie in hindsight. Only in hindsight: measured against the
CLI, that first frame carries `subtype: success`, `stop_reason: end_turn`,
`terminal_reason: completed`, `queued_turn_count: 0` and a `subagent_stats`
already reporting the agent as completed — byte for byte what a genuinely final
result carries. Nothing in it can be read as "more is coming". So the row is
written as normal and corrected when a turn begins that the user did not ask for:
it becomes `paused — waiting on background work`, amber rather than green, and
gives up its copy of the running cost total so one exchange does not bill twice.
The turn that follows says `resumed by task-notification`, which is the only frame
of the pair that knows what it is.

## The branch, and what it owes upstream

Laid out as VSCode lays it out. Leftmost, because it is the item the eye goes
to: the branch of the repo the strip is showing, a `*` when anything is
uncommitted, and one sync item carrying the glyph and both counts — `↓` for what
the upstream has and this branch does not, `↑` for the reverse. The repo path
follows as context for it rather than the other way round. Source Control
answers the same question in more detail, but only while it is the pane you have
open, and "which branch am I on" is a question asked while looking at something
else.

**The chip is also the switch.** Clicking it opens the branch list above the bar:
a filter box, local branches first and remote-tracking ones after, the current
one ticked, and a name that matches nothing offering to create it. The same
picker Source Control has, opened from the place the branch is already showing,
because "which branch am I on" and "put me on another one" are one question
asked twice. A popover rather than the menu the chip also carries on right-click:
a repo anyone works in has dozens of branches, and a menu with no filter is a
scroll.

Nothing is discarded on the way. The checkout is `git switch`, never `git
checkout` — `checkout <name>` also takes paths, so a branch name that happens to
match a file would silently throw that file's changes away instead of moving HEAD
— and a switch that would overwrite worktree changes is refused by git, in git's
own words, in the notice at the right of the bar. Picking `origin/main` when a
local `main` exists switches to the local one; picking a remote branch that has
no local counterpart creates it with its upstream already set. Which of the three
it is comes from looking the refs up rather than from the shape of the name, since
a local branch is very often called `feature/x` and guessing there produces a
silently wrong answer rather than an error.

Clicking the sync item does the useful, safe half of a sync in each state: pull
what is waiting, explain why it cannot be pulled, or — with nothing to take — go
and ask the remote what it has. Not VSCode's sync, which also pushes. Pushing
from a status bar is a decision this one does not make: Source Control has that
button, and it knows whether the branch needs its upstream set first.

The `*` is the one thing here that costs a worktree walk, so it has a slower
clock of its own and skips the untracked-file scan — the expensive half of a
status, since it descends directories git has nothing recorded for. A repo whose
only change is a brand new file therefore reads as clean. That is the wrong
answer, taken deliberately: the marker is a hint, and the alternative is a
directory crawl every few seconds on a monorepo.

At the other end of the bar sit the editor's own facts — `Ln 12, Col 4`,
`Spaces: 2`, `UTF-8`, `LF`, `TypeScript` — and only while there is a file in
front to have them. `UTF-8` is a statement about this app rather than a
detection: the Rust side reads and writes nothing else. Those facts travel from
the editor to the bar through a module store, not through `App`, for one reason:
the caret moves on every keystroke, and taking it through `App` state would
re-render the workbench once per character typed. This way the only thing that
re-reads is the one item showing it.

Nothing here is remembered. A checkout in a terminal tab, a commit made by a
session, a pull in the sidebar all move these numbers without telling the status
bar, so it re-reads them every few seconds instead of tracking them. That is
affordable only because the read is `git_tracking`, which is `symbolic-ref` and
`rev-list --count` — refs on disk and nothing else. `git_status` answers the same
question, but it answers it by walking every tracked file, and a poll doing that
on a monorepo is a stutter on every tick.

**Behind is a fact about the last fetch, not about the server.** So knowing
whether there is anything to pull means fetching, and Settings ▸ **Check for
upstream changes** is what allows it: `git fetch --all --prune` when a repo is
opened, and every five minutes after, skipped whenever the window is off screen.
A fetch writes remote-tracking refs and touches neither branches nor the
worktree. Turned off, the chip and its counts stay — they just stop moving on
their own.

**The offer arrives when it is still cheap to accept.** Opening a repo is the
moment before you start working in it, which is the one moment pulling is free;
an hour of edits later the same pull is a rebase. So a repo that opens with
commits waiting raises a dialog rather than lighting up two digits nobody was
looking at, and it does so once per set of commits — dismissing three says
nothing about the two that land afterwards, and the count is part of what
identifies the news. Deliberately not remembered across restarts: a reminder
that only ever fires once stops being a reminder.

Only the open interrupts. The five-minute ticks land mid-work, where a dialog
over the thing you are reading costs more than it tells you, so they move the
counts and light the `pull` button instead — the button is the notification.

**The pull is `--ff-only`, as it is in Source Control.** A pull that has to merge,
in a worktree you may be mid-edit in, is exactly where an implicit merge commit
is the wrong answer. A branch that has diverged is therefore not offered one at
all: the button says `diverged` and opens the explanation, because reconciling
the two sides is a merge or a rebase and picking between them is not something a
status-bar button should do on your behalf. Everything that fails, fails in git's
own words — a dirty file it would overwrite says so far better than any wording
here would.

Failures of the background fetch are silent, and that is the point: offline, no
credential helper, a lock held by your own `git` — none of them is worth a dialog
you did not open, and the next tick tries again.

## Who last touched each line

`Blame` in the editor's toolbar — or Show Blame in its right-click menu — puts a
column left of the line numbers: the author and a one-unit age on the first line
of every run, and nothing on the lines under it. Only the first line of a run is
labelled, because a block of twenty lines from one commit repeating one name
twenty times is noise, and the gaps are what make the blocks read as blocks. The
whole story — full sha, subject, author, timestamp — is in the hover, and clicking
a line opens what else that commit touched as a diff tab.

`git blame --porcelain` for the file, run in the file's own directory: an open
editor knows the absolute path of what it is showing and nothing about which repo
root it belongs to, and git resolves that from where the command runs. Porcelain
repeats a commit's details only the first time it appears, which is what makes the
payload a commit table plus one index per line rather than a 40-character sha on
every line — on a 5000-line file that shape is the difference between a few KB
and something bigger than the file.

**Blame describes the file on disk, not the buffer.** So it is re-read on the
mtime a save moves, and an unsaved edit dims the column instead of re-reading:
git cannot see a draft, and an insertion above a line means every name below it is
a row or more out of place. Dimmed and still there rather than hidden — the names
are still right about the blocks around them, and the hover says why they no
longer line up.

Lines you have not committed come back from git under an all-zero sha, and they
are labelled `Uncommitted` in the same amber the status bar marks uncommitted work
with, rather than left blank: "this line is yours and unsaved" is the most useful
thing the column can say about it. A file git has no history for — an untracked
one — fails, and git's own refusal goes in the editor bar, where it is a note
rather than an error: it does not stop you editing the file.

The column is one DOM node per line with no virtualisation, like the gutter beside
it, so the Rust side stops at 20 000 lines — past that the column runs out, which
is visible and cheap, where tens of thousands of nodes for a generated file would
not be. It is a third scroller driven from the textarea's own `scrollTop`, for the
same reason the gutter is one: a column with a scrollbar of its own drifts out of
step with the text it describes. And the on/off switch lives in a module store
rather than in `App` or in each editor, because file editors stay mounted while
hidden — a per-editor flag would leave the tab behind still showing a column that
was turned off in the tab in front.

## The whole history, at the width the graph needs

`Git History` is its own view on the activity rail — `Ctrl+Shift+H`, one button
below Source Control — and not a fourth section inside it. Two questions, two
places: what is staged and what a change did to the working tree is Source
Control; what landed, when, on which branch and in which commit is here. A
history scrolled back through the year would otherwise push the staging list
off the top of the pane every time it was used.

Source Control has no commit list of its own any more. It had one — the last
150 commits, one line each, at the bottom of the pane — and once this view
existed it was the same shas twice, one of them without the graph, taking room
from the change lists that pane is for.

It has two shapes. At rail width the filter boxes wrap, the author column goes,
dates shorten to `2h` / `3d`, and the commit detail sits under the list. The ⧉
button on its header opens the same history as a full-width tab, which is two
columns:

```
┌ History ───────────────────────────────────────────────────────────────────┐
│ [Message……] [Author…] [Path…]              [All branches ▾]  ⟳             │
├──────────────────────────────────────────────┬─────────────────────────────┤
│ ●  main origin/main  feat: the history …     │ f3866d8  main origin/main   │
│ ├●  chore: release v0.1.15         val   2h  │                 Whole patch │
│ ●│  fix: a merge's second parent …  ana  5h  │ feat: the history tab draws │
│ ●│  tag: v0.1.14  feat: a commit's … val  1d │ its own graph               │
│ │●  refactor: lane assignment …     val  1d  │                             │
│ ●╯  fix: the filter box treated …   ana  2d  │ Author   val <val@…>  11:48 │
│                                              ├─────────────────────────────┤
│                              [Load 200 more] │ 7 FILES CHANGED             │
│                                              │  M App.tsx        src +55 -3│
│                                              │  A HistoryPane.tsx …  +486  │
└──────────────────────────────────────────────┴─────────────────────────────┘
```

**The graph is drawn from what `git log` already said.** Every commit carries its
parents, so the lanes are a single left-to-right pass over the loaded page:
`layoutGraph` in `src/lib/graph.ts` allocates a lane per line of development,
frees it when the line ends, and emits the segments between two rows as three
kinds — one that passes the row by, one that ends at its commit, one that leaves
it. That split is what lets a merge draw its second parent as a curve out of the
node instead of a line through it. Pure and separately tested, because the
awkward shapes — an octopus merge, two branches converging, a parent below the
bottom of the loaded page — are cheap to write down as a list of commits in a
test and expensive to reproduce by clicking.

Lane colours are the theme's own accents aliased as `--graph-1 … --graph-8`, not
a palette of their own: a light theme draws its graph in its light colours, and
nothing has to be regenerated when `themes.css` is.

**A commit's files are a second read, not part of the first.** Selecting a row
runs one `git_commit_detail` — message body, committer, and the changed files
with their `+`/`−` counts from a single `git show --raw --numstat -z`. A page of
200 commits is 200 `git show`s if the log carries the files with it, to render a
list nobody has clicked in yet. Clicking one of those files opens *that file's*
patch (`git show <sha> -- <path>`), which is the thing the sidebar could never
do: `git show` on a release commit is a megabyte of patch to read one hunk out
of. `Whole patch` is still there for when the commit is the unit you want.

Merges are diffed against their first parent throughout (`-m --first-parent`).
Git's default for a merge is the combined diff, which is empty unless the merge
had conflicts — so a file changed on the branch that was merged would list and
then open blank.

**The filters are `git log`'s own.** Message, author and path go to `--grep`,
`--author` and a pathspec; the branch picker replaces `--all` with one starting
point. Anything typed is matched as text and never as a regex — `--fixed-strings`
and `--regexp-ignore-case` — because `fix(a.b)` pasted from a subject line should
find that subject line, and a filter box that quietly accepts regexes is a filter
box that quietly drops commits. A blank box is not a filter: `--author=` matches
everything rather than nothing, so empty has to mean absent before it reaches
git.

Both shapes are the same component, told which one to be. A prop rather than a
container query, because the two differ in *what they show* and not only in how
it is arranged — the rail view drops a column the tab keeps.

Hidden, neither runs any git. Both stay mounted while hidden — the rail view
like the other three, the tab like a file tab — because a loaded page, a typed
filter and the selected commit are worth more than the memory they cost, and
each re-reads on the first frame it is visible again if anything it was asked
changed meanwhile. One tab per repo, keyed `history|<cwd>`, and it comes back on
relaunch: unlike a diff tab there is nothing derived to store, only which repo
it was.

Reads only. Nothing here rewrites history or moves a ref — no revert, no
cherry-pick, no checking out a commit. Those belong next to the working tree
they would disturb, which is Source Control, one button up the rail, with the
change lists in view.

## Knowing there is a newer mangouste

The other end of the status bar carries news about the app itself. A chip
appears there — `⭳ update 0.2.0` — when the project's latest published GitHub
release is a higher version than the bundle running, and nothing at all appears
otherwise, which is almost always. Clicking it opens the release notes; so does
`Help ▸ Check for Updates…`, which asks on the spot and reports either answer.

It is a notice and not an updater, and that is a distribution fact rather than a
missing feature. This app ships as a `.deb`, an AppImage and a `.dmg`. A `.deb`
install belongs to apt and would be wrong to overwrite from underneath it; and
replacing the other two in place needs Tauri's updater plugin, which needs a
minisign keypair whose public half is baked into every bundle — lose the private
half and every install ever shipped stops being updatable. So the sheet's
`Download` button opens the release page in a browser, where the artefact for
the way *you* installed is the one you pick. On macOS, `install-macos.sh` is
still the shortest path, and re-running it is the update.

The version comparison is arithmetic, not a string compare, and it lives in
`src/lib/update.ts` with a test for the case that motivates saying so: `0.1.13`
is newer than `0.1.9`, which every string compare gets backwards. A pre-release
sorts below the release it leads to, an unparseable version compares to
"cannot say" rather than to a guess, and every one of those paths turns into
silence rather than a wrong notice.

`Skip this version` silences one release, not the feature. The version is
remembered rather than a flag being set, because "not now" is an answer about
*this* release and the next one has to be able to interrupt again — otherwise
the notice is worth nothing.

The first launch after an update opens **What's new** by itself, once. The
bundle carries no changelog, so the notes come from the release the running tag
names; the app knows it restarted into a different version because it wrote the
previous one down. A fresh install is not an update and gets no sheet, and
neither does a deliberate downgrade.

The request is one anonymous `GET` of a public endpoint, made from Rust and not
from the webview — the CSP in `tauri.conf.json` allows `'self'` and the IPC
origin and nothing else, deliberately, which is why `src-tauri/src/update.rs`
exists rather than a `fetch` in a component. Nothing is sent: no token, no
identifier, not even the version being compared, which is compared here. Once
about twenty seconds after launch and every six hours after that, and anonymous
GitHub allows sixty requests an hour per IP — so `Settings ▸ Check for mangouste
updates ▸ off` stops the polling, and leaves the menu item and the what's-new
sheet working, because those are requests rather than a poll.

Releases here are cut as drafts, and `/releases/latest` does not see a draft.
A tag that has been pushed but not published therefore reads as "nothing to
report", which is the right answer: nobody should be told to download something
that is not downloadable yet. Failures are silent on the timer and spoken on the
menu item — a rate limit or an offline laptop is not worth a notice about a
check nobody asked to run, but it is worth an answer to someone who did.

## Terminal

`Ctrl+\`` toggles the panel; `Ctrl+Shift+T` adds a tab, `Ctrl+Shift+5` splits the
one in front side by side, `Ctrl+Shift+W` closes a pane. Copy and paste are
`Ctrl+Shift+C/V`, because plain `Ctrl+C` has to reach the shell — and `Cmd+C/V`
on macOS, where it does not. Both go through the Rust clipboard commands rather
than `navigator.clipboard`, which is gated on a user gesture the webview does
not always credit. `Ctrl+Shift+M` moves the
whole panel between the bottom of the column and the right of the chat, and each
dock remembers the size it was last dragged to under its own key — a stored
height means nothing as a width.

The dock switch is one `flex-direction` on a wrapper, deliberately: the panel
keeps its place among that wrapper's children in both orientations, because React
re-parenting it would unmount it and `TerminalPane`'s cleanup closes its pty. For
the same reason a hidden pane — another repo's, another tab's, the whole panel
collapsed — is a pane with `display: none` and a live shell behind it, never an
absent one. `refitToken` is what re-runs xterm's `fit()` once the box has layout
again, since a `display: none` box has no measurable size.

Whether the panel is open at all is a per-repo fact, remembered across
restarts. The shells were already split per repo — a hidden repo's set stays
alive behind whichever one is in front — so a single visibility flag was the
missing half of that split: closing the panel to read a diff in one repo should
not also close it in the repo where you live in the shell. A repo you have
never touched still opens with the panel shown, as before. Switching into a
repo whose panel was hidden is one more of those `display: none` transitions,
so it too bumps `refitToken` — the panel had no measurable size while another
repo was in front, and its grids must be re-fitted before they are worth
looking at.

## Tests

Rust owns the parsing and the process handling, and has the older suite:
`cargo test`, over the transcript scanner, the stats accumulator, the `ps`
shapes, the login-shell PATH probe, the workspace writer, the formatter
resolution and the find-and-replace matcher. No count here: it went stale on the
commit after it was written.

The frontend suite is `npm test` (vitest, node environment, no jsdom) and
deliberately covers only pure functions: the menu model's tidy/expand rules and
cursor arithmetic, chord parsing, path arithmetic, the persistence guards, and
the user-agent parsing behind Help ▸ About. Nothing drives React. The rule of
thumb is that if a test would need a DOM, the logic under it probably wants
extracting first — which is how `lib/menuModel.ts` came out of `lib/menu.tsx`.

It has already earned itself: `readNumber` returned `0` for a stored empty
string, because `Number("")` is `0` and passes `isFinite`. That is a collapsed
pane size, restored silently on every launch.

## X11 selection behaviour

Linux only: everything in this section is skipped on macOS, where PRIMARY does
not exist and the native Edit menu carries the clipboard.

WebKitGTK does not wire PRIMARY into webview-editable content, so both halves of
the X11 convention are reimplemented:

- selecting text anywhere publishes it to PRIMARY (`src/lib/primary.ts`)
- middle-click on any input or textarea inserts PRIMARY at the caret
- the same pair is wired directly into xterm, which handles its own mouse events

Insertion goes through `execCommand("insertText")` so the native undo stack
survives, with a manual splice as fallback.

## Menus

A menu bar sits in the titlebar — File, Edit, View, Terminal, Help — and every
surface in the window answers right-click. Both are the same implementation
(`src/lib/menu.tsx`); the webview's own context menu is suppressed app-wide,
since it offers "Reload" over a page with nowhere to reload to and paints over
anything the app draws.

Panes describe their own menus as arrays of entries, with two sentinels that
expand at open time against whatever was under the pointer:

- `"editing"` — Undo/Cut/Copy/Paste/Select All for the clicked target, plus
  link actions when the click landed on an anchor
- `"app"` — the workbench-wide block, so an unwired corner still offers
  something useful

Clipboard work goes through the Rust commands rather than
`navigator.clipboard`, which under WebKitGTK is gated on a user gesture a menu
item does not count as. Nothing in a context menu mutates the filesystem: the
tree offers open, copy and reveal, and the only destructive entry anywhere is
the SCM pane's Discard, which keeps its confirmation.

macOS has a second, native menu bar above this one — see
[Platforms](#platforms) for why it has to exist. It carries only what AppKit
insists on owning (about, hide, quit, and the editing items ⌘C/⌘V/⌘Z are routed
through), so File, View, Terminal and Help stay in the window with their app-
specific entries, and the in-window Edit menu keeps Copy Active Path and Copy
Session Id.

Help ▸ About reads its version from Tauri (which reads `tauri.conf.json`) and
its commit and build stamp from Vite `define`, so a release updates it without
anyone editing a string. Help ▸ Keyboard Shortcuts renders straight off the
`CHORD` table in `src/lib/keybindings.ts`, which is also what fills the menus'
accelerator column.

The bar is reachable without a mouse: `F10` opens it, the arrow keys walk both
the bar and the submenus, and one letter jumps to the next entry starting with
it. A mouse-up is ignored for the first 250 ms after a menu opens — a menu that
flipped upward to fit on screen puts a row under the pointer, and the release of
the click that opened it would otherwise pick that row.

### One declaration per action

Every action is a `Command` — id, label, chord, `run`, plus `checked`/`disabled` —
built once in `Workbench` and read by everything else. `src/panes/menus.ts` names
commands by id and never restates them, so it describes *where* an action appears
and nothing about what it is.

The chord string is the binding, not just the label: `matchChord` in
`src/lib/commands.ts` parses the same `"Ctrl+Shift+E"` the accelerator column
prints. Before this there were three copies of every action — a hand-written
`event.ctrlKey && event.shiftKey && event.key === "e"`, a display string, and a
menu entry — and nothing tied them together.

Two details the matcher earns its keep on. It compares `KeyboardEvent.code`, so
`Ctrl+Shift+5` still fires on a layout where that key sends `%`. And it demands
an *exact* modifier match, so `Ctrl+N` stays off `Ctrl+Shift+N` — two commands
answering one keystroke is the failure mode a looser test invites.

Commands marked `shellFirst` stand down when the keystroke landed in a terminal.
That is the whole of the readline exception, and it travels with the command
instead of living as a list of special cases in the key handler.

## Keybindings

Single source of truth: `src/lib/keybindings.ts`.

| Key | Action |
| --- | --- |
| `Enter` | Send message |
| `Shift+Enter` | Newline in composer |
| `Ctrl+P` | Open recent — type-to-filter repo switcher |
| `Ctrl+N` | New session in the active repo |
| `Ctrl+Shift+N` | Second window on the same sessions |
| `Ctrl+W` | Close the tab in front |
| `Ctrl+S` | Save the file in front |
| `Shift+Alt+F` | Reformat the file with the repo's own formatter |
| `Ctrl+,` | Settings |
| `Ctrl+\`` | Toggle terminal |
| `Ctrl+Shift+T` | New terminal tab |
| `Ctrl+Shift+5` | Split terminal side by side |
| `Ctrl+Shift+W` | Close terminal pane |
| `Ctrl+Shift+M` | Dock the terminal panel bottom / right |
| `Ctrl+B` | Toggle left sidebar |
| `Ctrl+Shift+E/F/G` | Explorer / Find & Replace / Source Control |
| `Ctrl+Shift+D` | Dashboard |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in, out, reset |
| `F11` | Full screen |
| `Middle click` | Paste PRIMARY |
| `Ctrl+Shift+C/V` | Copy/paste in terminal |

`Ctrl+N` and `Ctrl+W` are readline chords too, so both stand down when the
keystroke landed inside a terminal. The exception is keyed on the chord, not the
command: once the chord moves to Cmd there is no shell to yield to, so it stops
standing down.

On macOS the table is rewritten once, at import — Ctrl becomes Cmd, which is
what every editor on that platform means by these chords and what leaves the
system's own Ctrl+letter bindings inside text fields alone. Four entries are not
a mechanical rename:

| Key | macOS | Why |
| --- | --- | --- |
| `Ctrl+\`` | `Ctrl+\`` | ⌘\` is cycle-windows; the editors keep this one on Ctrl |
| `F11` | `Ctrl+Cmd+F` | F11 is a media key without holding fn |
| `Ctrl+Shift+C/V` | `Cmd+C/V` | Ctrl+Shift only exists so Ctrl+C reaches the shell |
| `Middle click` | — | no PRIMARY to paste |

The chord string is still both the binding and the label: `matchChord` parses
what the accelerator column shows, and `formatChord` is presentation only — it
prints `Cmd+Shift+E` as `⇧⌘E`, in the order macOS prints modifiers.

## Switching repos

There is no repo dropdown. The Sessions rail *is* the repo list: click a group
label to switch the file tree, git pane, and terminal to that repo; click the
twisty to collapse it. Each repo keeps its own terminals, and they keep running
while another repo is in front — switching back finds the same shells with their
scrollback, not fresh logins, and the panel open or hidden the way you left it
there. `Ctrl+P` opens a type-to-filter palette ranked by real
session recency, with every other git repo under `~/workspace` below that.
Matching is a subsequence test on the repo name plus a substring test on the
full path, so `pay` finds `payments-service` and `ws/an` finds `~/workspace/ansible`.

## A second window

`Ctrl+Shift+N`, or File ▸ New Window. Another window on the *same* process, not
a second copy of the app: one session watcher, one chat manager, one permission
bridge. Both windows list every session on the machine, because both are reading
the same `~/.claude/projects`.

What belongs to a window is its layout — the repo in front, the tab strip, the
sidebar and terminal geometry. Those keys carry the window's label
(`mangouste.openTabs.window-2`), so two strips cannot overwrite each other, and
a label is reused as soon as it is free so a second window comes back where the
last one was. What belongs to the *person* stays shared: theme, model,
permission mode, and which sessions have been read. A preference chosen in one
window is a preference.

Chats and terminals belong to the window that started them and close with it —
`chats::kill_owned_by` and `pty::close_owned_by`, both on `WindowEvent::Destroyed`
rather than `CloseRequested`, since by the time a window-manager close is
observable the webview is already gone and the `pty_close` an unmounting pane
would have sent never went out. This is the promise the app has always made
(children die with the window) made per window, and it has to be per window:
nothing can answer a permission prompt raised by a chat whose pane no longer
exists.

Ids are what make the two windows separate rather than interleaved. A terminal
id and a "New session" id are minted from counters that restart with each
webview, and both are routing keys in Rust — `pty_open` closes whatever it holds
under the id it is handed, and `claude_start` attaches to a live chat rather than
spawning — so a second window's `term:1` would have killed the first window's.
Ids minted outside `main` carry the label (`window-2:term:1`). Resumed sessions
are deliberately not scoped: `chat|<cwd>|<uuid>` is content-derived, so opening
one session in both windows attaches both panes to the one process.

A second *instance* is a different thing and still refused. The permission
bridge is a single socket this process owns; a second launch asks the running
one to raise itself and exits.

Two windows do run two of everything the frontend polls — the usage window, the
upstream check, the git status sweep. Nothing is shared between them but the
backend.

## Not implemented yet

- Reverting, cherry-picking or checking out a commit from Git History. It reads;
  Source Control writes — see The whole history above
- Streaming text. `stream_event` deltas drive the spinner and the "preparing
  tool" state, but prose still appears when the turn settles, not as it arrives
- Quick-open over file names. The palette ranks repos and sessions; `search_files`
  is wired to the composer's `@` mention menu instead
- New file, rename and delete in the tree. Every filesystem write goes through
  the editor or through claude, and the context menus deliberately kept it that
  way — see Menus above
- Updating itself. The app notices a new release and shows its notes; installing
  one is a download in a browser. See Knowing there is a newer mangouste above
  for why, and what it would cost to change
