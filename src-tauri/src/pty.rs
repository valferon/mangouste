//! PTY-backed terminals for the bottom panel.
//!
//! Output is base64-encoded before it crosses the IPC boundary: a read can split
//! a UTF-8 sequence or an escape sequence in half, and lossy string conversion
//! would corrupt xterm.js state.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

pub const EVENT_DATA: &str = "pty://data";
pub const EVENT_EXIT: &str = "pty://exit";

/// Read buffer size. Large enough that bulk output does not thrash the IPC bridge.
const READ_CHUNK: usize = 16 * 1024;

/// How long a burst of output may collect before it goes out as one event.
/// Under a frame, so typing stays snappy while floods stop emitting per-read.
const COALESCE_WINDOW: Duration = Duration::from_millis(8);

/// Ceiling on one coalesced event, so a flood still flows in bounded pieces.
const MAX_COALESCED: usize = 256 * 1024;

/// How many read chunks the reader may run ahead of the emitter. 32 chunks is
/// 512 KB, and that ceiling is all the bound buys: it caps this channel's own
/// memory. It is not backpressure on a flood, because `app.emit` only queues
/// the event — through `eval` into tao's unbounded event-loop queue — and
/// returns, so a `yes`-style flood still grows this process, in that queue and
/// the webview heap where nothing here can see it. The reader parks only when
/// the emitter is behind on its own encoding work, not when the frontend is.
const OUTPUT_BACKLOG: usize = 32;

/// How long a closing shell may take to act on SIGHUP before it is killed.
/// Enough for bash to run its exit traps and hang up its own jobs.
const CLOSE_GRACE: Duration = Duration::from_millis(250);

/// Poll interval while waiting out `CLOSE_GRACE`.
const CLOSE_POLL: Duration = Duration::from_millis(25);

struct Terminal {
    instance: u64,
    master: Box<dyn MasterPty + Send>,
    /// Behind its own lock so a write can run with the terminal map released:
    /// a PTY write blocks when the app floods input, and holding the map
    /// across that would wedge every other terminal command.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// Reaped by whoever takes this entry out of the map: `pty_close`, a reopen
    /// of the same id, or the emitter thread once the shell exits by itself.
    /// Nothing else waits on it — `terminate_group` is the only reaper, so the
    /// pid it signals is still this shell's.
    child: Box<dyn Child + Send + Sync>,
    /// Cleared by the emitter thread when the pump ends, so `pty_list` can
    /// answer without a `try_wait` that would reap the child behind
    /// `terminate_group`'s back.
    alive: Arc<AtomicBool>,
    cwd: String,
}

#[derive(Default)]
pub struct PtyState {
    terminals: Mutex<HashMap<String, Terminal>>,
    /// Held across the whole of `pty_open`, whose close-then-spawn is not
    /// atomic. One lock for every id rather than a set of ids mid-spawn: an
    /// open is a spawn plus at most one `CLOSE_GRACE`, and opens happen when a
    /// pane mounts, so the contention is not worth the bookkeeping.
    open_guard: Mutex<()>,
    next_instance: AtomicU64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    /// Monotonic id for this spawn, so a stale `pty_close` cannot kill the
    /// terminal that replaced it.
    pub instance: u64,
    pub cwd: String,
    pub alive: bool,
}

fn login_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
}

/// Open a terminal running the user's login shell in `cwd`.
///
/// `async` so the spawn does not run on the GTK main thread, matching
/// `pty_write`; the body stays sync and the macro puts it on the threadpool.
/// That threadpool is why `open_guard` exists: sync commands were serialised by
/// the main thread, and two opens of one id are routine — `React.StrictMode`
/// mounts a pane twice and the first cleanup defers its `pty_close` behind the
/// first open's reply, so both opens are genuinely in flight together.
#[tauri::command(async)]
pub fn pty_open(
    app: AppHandle,
    state: State<'_, PtyState>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, String> {
    // Serialise the close-then-spawn below: two concurrent opens of one id
    // would both find nothing to close, both spawn a login shell, and the
    // loser's `insert` would drop a `Terminal` whose `Child` neither signals
    // nor reaps — an immortal orphan holding a slave the reader still `dup()`s.
    // Waiting rather than rejecting, because the caller that arrives second is
    // the one whose pane is bound to the terminal it asked for.
    let _open_guard = state.open_guard.lock();
    close_terminal(&state, &id, None);
    let instance = state.next_instance.fetch_add(1, Ordering::SeqCst) + 1;

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut command = CommandBuilder::new(login_shell());
    command.arg("-l");
    command.cwd(&cwd);
    // Keep colour and mouse reporting working inside the webview terminal.
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    let child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
    // Dropping the slave lets the reader see EOF once the shell exits.
    drop(pair.slave);

    // From here the shell is running: an early return must reap it, or the
    // spawned process leaks with nothing holding a handle to it.
    let reap = |mut child: Box<dyn Child + Send + Sync>, e: String| {
        terminate_group(&mut *child);
        e
    };
    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(e) => return Err(reap(child, e.to_string())),
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(e) => return Err(reap(child, e.to_string())),
    };

    let alive = Arc::new(AtomicBool::new(true));
    let displaced = state.terminals.lock().insert(
        id.clone(),
        Terminal {
            instance,
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            child,
            alive: Arc::clone(&alive),
            cwd: cwd.clone(),
        },
    );
    // Belt and braces behind `open_guard`: there should be nothing here to
    // displace, and whatever is has just been orphaned by this `insert`.
    if let Some(mut previous) = displaced {
        terminate_group(&mut *previous.child);
    }

    // The map entry goes in before the pump starts: a shell that dies at once —
    // a broken login shell exits before this function returns — would otherwise
    // reach the emitter's cleanup while the map is still empty, and the entry
    // inserted afterwards would never be reaped.
    {
        let app = app.clone();
        let id = id.clone();
        let alive = Arc::clone(&alive);
        // Two threads: the reader pumps raw chunks into a bounded channel, and
        // the emitter coalesces short bursts so a flood of output becomes one
        // IPC event rather than one per read. The bound keeps this channel from
        // growing past `OUTPUT_BACKLOG` chunks; it does not throttle a flood,
        // since `app.emit` returns as soon as the event is queued.
        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(OUTPUT_BACKLOG);
        std::thread::spawn(move || {
            let mut buf = vec![0u8; READ_CHUNK];
            loop {
                match reader.read(&mut buf) {
                    // A signal landing mid-read is not the shell dying — both
                    // GLib and tokio install handlers in this process. Breaking
                    // would close `tx`, and the emitter's cleanup below would
                    // hang up the shell and every job in it.
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        std::thread::spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut pending = first;
                // Bounded drain: whatever lands inside the window joins this
                // event; the deadline keeps interactive echo under a frame.
                let deadline = Instant::now() + COALESCE_WINDOW;
                while pending.len() < MAX_COALESCED {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    match rx.recv_timeout(deadline - now) {
                        Ok(more) => pending.extend_from_slice(&more),
                        Err(_) => break,
                    }
                }
                let _ = app.emit(
                    EVENT_DATA,
                    serde_json::json!({
                        "id": id,
                        "instance": instance,
                        "data": BASE64.encode(&pending)
                    }),
                );
            }
            // The channel ends only when the reader saw EOF/EIO on the master,
            // i.e. every process holding the slave is gone: the shell exited on
            // its own (`exit`, Ctrl-D, a crash) or a close already killed it.
            // The flag goes first, so a `pty_list` racing this cannot call a
            // terminal alive after the frontend has been told it exited.
            alive.store(false, Ordering::SeqCst);
            let _ = app.emit(EVENT_EXIT, serde_json::json!({ "id": id, "instance": instance }));
            // Reap here, because nothing else does: the frontend only calls
            // `pty_close` when the pane unmounts, so a shell that exited by
            // itself would sit in the map as a zombie — holding a master fd and
            // a writer, and answering `pty_write` — until the same id was
            // reopened. `Some(instance)` keeps this off the terminal that has
            // already replaced this one.
            if let Some(state) = app.try_state::<PtyState>() {
                close_terminal(&state, &id, Some(instance));
            }
        });
    }

    Ok(TerminalInfo { id, instance, cwd, alive: true })
}

/// Write keystrokes to a terminal. `data` is base64 so control bytes survive.
///
/// `async`, and the writer is cloned out before writing: a blocking PTY write
/// must hold neither the main thread nor the terminal map.
#[tauri::command(async)]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let bytes = BASE64.decode(data.as_bytes()).map_err(|e| e.to_string())?;
    let writer = {
        let terminals = state.terminals.lock();
        let terminal = terminals.get(&id).ok_or("no such terminal")?;
        Arc::clone(&terminal.writer)
    };
    let mut writer = writer.lock();
    writer.write_all(&bytes).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let terminals = state.terminals.lock();
    let terminal = terminals.get(&id).ok_or("no such terminal")?;
    terminal
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

/// Hang up a terminal's whole process group, then reap the shell.
///
/// `Child::kill` signals the shell pid alone (portable-pty 0.9: SIGHUP, a short
/// grace, SIGKILL), which leaves everything the shell moved into another process
/// group — every background job under job control, `nohup`, `disown` — running
/// with the slave open. No hangup reaches those either, because the reader
/// thread holds a `dup()`ed master fd that keeps the pty alive past this drop.
/// `spawn_command` calls `setsid()`, so the shell's pid is also its process
/// group id: signalling the group reaches the shell and every descendant still
/// in it, and starting with SIGHUP lets bash run its exit traps and hang up its
/// own jobs.
///
/// The group is signalled before the child is waited on, because an already
/// exited shell is the case that most needs the signal: `sleep 300 & disown`
/// then `exit` leaves a zombie shell whose job still holds the slave, so the
/// reader never sees EOF and this call is the only thing that will ever hang
/// that job up. Signalling a stale pid is not a hazard here because nothing
/// else reaps — `pty_list` reads a cached flag rather than calling `try_wait`,
/// and each child reaches this function once, via the entry that owns it — so
/// the shell is either running or a zombie, and either way its pid is still
/// allocated to it and so is the group id that equals it. Residual: a job that
/// called `setsid` itself is in another session and never sees the hangup, and
/// so does a job that ignores SIGHUP after the shell has already gone, since
/// the escalation to SIGKILL is keyed on the shell's own exit; the reader
/// thread then stays parked on the master until that job exits.
fn terminate_group(child: &mut (dyn Child + Send + Sync)) {
    if let Some(pid) = child.process_id() {
        unsafe { libc::killpg(pid as i32, libc::SIGHUP) };
        let deadline = Instant::now() + CLOSE_GRACE;
        // Exits at once for a shell that was already a zombie: `try_wait`
        // caches the status, so neither this nor the `wait` below can block.
        while !matches!(child.try_wait(), Ok(Some(_))) {
            if Instant::now() >= deadline {
                unsafe { libc::killpg(pid as i32, libc::SIGKILL) };
                break;
            }
            std::thread::sleep(CLOSE_POLL);
        }
    }
    let _ = child.wait();
}

/// Close the terminal under `id`. When `instance` is given, the close only
/// applies if it still refers to that spawn.
///
/// Takes `&PtyState`, not the `State` wrapper, so the emitter thread can call it
/// through `app.try_state()`. The entry leaves the map before anything is
/// signalled: `terminate_group` sleeps out a grace period, and holding the map
/// across that would wedge every other terminal command. Ownership also settles
/// the race between a self-exiting shell and an explicit close — whichever side
/// takes the entry does the reap, the other finds nothing.
fn close_terminal(state: &PtyState, id: &str, instance: Option<u64>) {
    let removed = {
        let mut terminals = state.terminals.lock();
        match terminals.get(id) {
            Some(terminal) if instance.is_some_and(|wanted| wanted != terminal.instance) => None,
            Some(_) => terminals.remove(id),
            None => None,
        }
    };
    if let Some(mut terminal) = removed {
        terminate_group(&mut *terminal.child);
    }
}

/// `async` for the same reason as `pty_open`: closing polls the child for up to
/// `CLOSE_GRACE` before escalating, which is too long to hold the UI thread.
#[tauri::command(async)]
pub fn pty_close(
    state: State<'_, PtyState>,
    id: String,
    instance: Option<u64>,
) -> Result<(), String> {
    close_terminal(&state, &id, instance);
    Ok(())
}

#[tauri::command]
pub fn pty_list(state: State<'_, PtyState>) -> Vec<TerminalInfo> {
    state
        .terminals
        .lock()
        .iter()
        .map(|(id, terminal)| TerminalInfo {
            id: id.clone(),
            instance: terminal.instance,
            cwd: terminal.cwd.clone(),
            // The cached flag, not `try_wait`: reaping here would let the
            // kernel recycle the pid before `terminate_group` signals the
            // group. It clears when the pump ends — no process holds the slave
            // any more — a moment before the emitter drops the entry, so a
            // `false` here is a narrow window. A zombie shell whose disowned
            // job still holds the pty therefore reads as alive, which is what a
            // write to that pty still finds.
            alive: terminal.alive.load(Ordering::SeqCst),
        })
        .collect()
}
