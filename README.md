# mangouste

Single-window, multi-repo Claude Code workbench. Replaces running one
VSCode window per repository.

```
┌─────────────────────────────────────────────────────────────────────┐
│ mangouste  [ payments-service      Ctrl+P ]              [terminal] │
├──────────────┬────────────────────────────────────┬─────────────────┤
│ Explorer     │ Chat │ file.ts │ a1b2c3 fix …      │ Sessions        │
│              ├────────────────────────────────────┤ 3 live · 144    │
│  file tree   │                                    │                 │
│              │   stream-json chat with Claude     │  ● playground   │
├──────────────┤                                    │  ○ web-app      │
│ Source Ctrl  │                                    │  ● payments-…   │
│  status      ├────────────────────────────────────┤                 │
│  history     │ Terminal                    Ctrl+` │                 │
└──────────────┴────────────────────────────────────┴─────────────────┘
```

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

`claude` must be on PATH, or at one of the probed locations
(`~/.local/bin`, `~/.claude/local`, `~/.bun/bin`, `/usr/local/bin`, `/usr/bin`).
Override with `MANGOUSTE_CLAUDE_BIN`.

## Run

```bash
npm install
npm run app          # tauri dev
npm run app:build    # deb + AppImage in src-tauri/target/release/bundle
```

A locally built `.deb` will not install until its `Depends` is repaired — Tauri
appends its own hardcoded `libgtk-3-0`, which has no candidate on Ubuntu 24.04.
CI does this step; `app:build` does not:

```bash
./scripts/fix-deb-depends.sh src-tauri/target/release/bundle/deb/*.deb
```

## Platforms

Linux is the primary target and the only one built locally by `app:build`.

macOS builds on CI (`.github/workflows/build.yml`, `macos-14`, native arm64) and
produces a `.dmg`. Two things behave differently there:

- middle-click paste does nothing. PRIMARY is an X11 selection with no macOS
  equivalent, so `primary.rs` compiles to inert stubs off Linux
- the "waiting on" line under a running turn stays blank. It reads the process
  group from `/proc` on Linux and from `ps` elsewhere; the `ps` path is tested
  but has not been exercised on real hardware

The `.dmg` is unsigned and un-notarized, so Gatekeeper will refuse it until the
quarantine attribute is cleared:

```bash
xattr -d com.apple.quarantine /Applications/mangouste.app
```

## Icon

Source art is `src-tauri/icons/source/mangouste.svg` — the three-pane workbench,
one amber node in the sessions rail. Regenerate every raster size from it:

```bash
convert -background none src-tauri/icons/source/mangouste.svg -resize 1024x1024 /tmp/icon.png
npx tauri icon /tmp/icon.png
```

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
| `src-tauri/src/git.rs` | `git` porcelain: status, log, show, diff |
| `src-tauri/src/workspace.rs` | Repo discovery, lazy tree, quick-open search |
| `src-tauri/src/primary.rs` | X11 PRIMARY + CLIPBOARD access |

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
| `idle` | Nothing for over 24 h |

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

## X11 selection behaviour

WebKitGTK does not wire PRIMARY into webview-editable content, so both halves of
the X11 convention are reimplemented:

- selecting text anywhere publishes it to PRIMARY (`src/lib/primary.ts`)
- middle-click on any input or textarea inserts PRIMARY at the caret
- the same pair is wired directly into xterm, which handles its own mouse events

Insertion goes through `execCommand("insertText")` so the native undo stack
survives, with a manual splice as fallback.

## Keybindings

| Key | Action |
| --- | --- |
| `Enter` | Send message |
| `Shift+Enter` | Newline in composer |
| `Ctrl+P` | Open recent — type-to-filter repo switcher |
| `Ctrl+\`` | Toggle terminal |
| `Ctrl+Shift+T` | New terminal tab |
| `Ctrl+Shift+5` | Split terminal vertically |
| `Ctrl+Shift+W` | Close terminal pane |
| `Ctrl+B` | Toggle left sidebar |
| `Middle click` | Paste PRIMARY |
| `Ctrl+Shift+C/V` | Copy/paste in terminal |

## Switching repos

There is no repo dropdown. The Sessions rail *is* the repo list: click a group
label to switch the file tree, git pane, and terminal to that repo; click the
twisty to collapse it. Each repo keeps its own terminals, and they keep running
while another repo is in front — switching back finds the same shells with their
scrollback, not fresh logins. `Ctrl+P` opens a type-to-filter palette ranked by real
session recency, with every other git repo under `~/workspace` below that.
Matching is a subsequence test on the repo name plus a substring test on the
full path, so `pay` finds `payments-service` and `ws/an` finds `~/workspace/ansible`.

## Not implemented yet

- Commit lane graph — `parents` and `refs` are plumbed through, nothing draws them
- `stream_event` partial deltas are ignored; text appears when the turn settles
- Permission prompts: `can_use_tool` control requests are not answered, so
  interactive `default` mode will stall. Use `acceptEdits` or `plan`.
- Quick-open UI over `search_files`
- File editing — viewer is read-only by design
