import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { onPtyData, onPtyExit, primaryGet, primarySet, ptyClose, ptyOpen, ptyResize, ptyWrite } from "../lib/ipc";

interface TerminalPaneProps {
  id: string;
  cwd: string;
  /** Height changes are not observable from inside, so the parent nudges a refit. */
  refitToken: number;
  /** Changes when the app theme does, so the canvas palette can be rebuilt. */
  themeKey: string;
  /**
   * Bumped by the parent when this pane should take the caret. `0` means never:
   * a pane that is merely mounted — the panel opening, another repo coming
   * forward — must not pull focus out of whatever the user was typing in.
   */
  focusRequest?: number;
}

/**
 * Build the xterm palette from the live CSS variables.
 *
 * xterm paints to a canvas, so it cannot inherit CSS the way the rest of the app
 * does — the colours have to be read out and handed over explicitly, and redone
 * whenever the theme changes.
 */
function readTheme() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  const background = token("--bg", "#1f1f1f");
  const foreground = token("--fg", "#cccccc");
  return {
    background,
    foreground,
    cursor: foreground,
    selectionBackground: token("--bg-active", "#264f78"),
    // `black` must never equal the background, or ESC[30m text is invisible.
    black: token("--term-black", "#3b3b3b"),
    red: token("--red", "#f14c4c"),
    green: token("--green", "#23d18b"),
    yellow: token("--amber", "#f5f543"),
    blue: token("--blue", "#3b8eea"),
    magenta: token("--purple", "#d670d6"),
    cyan: token("--cyan", "#29b8db"),
    white: token("--term-white", "#cccccc"),
    // Without these eight, xterm silently keeps its Tango defaults, which are
    // unreadable on a light background.
    brightBlack: token("--term-bright-black", "#666666"),
    brightRed: token("--term-bright-red", "#f14c4c"),
    brightGreen: token("--term-bright-green", "#23d18b"),
    brightYellow: token("--term-bright-yellow", "#f5f543"),
    brightBlue: token("--term-bright-blue", "#3b8eea"),
    brightMagenta: token("--term-bright-magenta", "#d670d6"),
    brightCyan: token("--term-bright-cyan", "#29b8db"),
    brightWhite: token("--term-bright-white", "#e5e5e5"),
  };
}

const encoder = new TextEncoder();

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * xterm.js over a Rust-side PTY.
 *
 * xterm handles its own mouse events, so the document-level PRIMARY bridge does
 * not reach it. Both halves are re-wired here directly against the terminal:
 * selecting publishes to PRIMARY, middle-click writes PRIMARY to the shell.
 */
export function TerminalPane({
  id,
  cwd,
  refitToken,
  themeKey,
  focusRequest = 0,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /**
   * Set once the shell behind this pane is gone.
   *
   * Every `ptyWrite`/`ptyResize` is fire-and-forget, and the Rust side answers
   * "no such terminal" the moment it drops the terminal from its map. With no
   * `unhandledrejection` handler those rejections are invisible, so without
   * this flag a dead pane looks alive and silently eats every keystroke. A ref
   * because the refit effect below has to see it too, and flipping it must not
   * re-render (or re-run the effect that owns the terminal).
   */
  const deadRef = useRef(false);
  /**
   * Bumped to spawn a replacement shell in place.
   *
   * The panel is no longer unmounted when the terminal is hidden, and the Rust
   * side drops a terminal from its map as soon as its shell exits, so toggling
   * is not a way back from `exit` or a failed open. Enter after death is.
   */
  const [generation, setGeneration] = useState(0);
  const respawn = () => setGeneration((current) => current + 1);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'Ubuntu Mono', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      theme: readTheme(),
      // Backstop for any colour a program picks that still lands too close to
      // the background — xterm lightens or darkens it until it is readable.
      minimumContrastRatio: 4.5,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    // A remount is a fresh shell, so whatever killed the last one does not
    // carry over.
    deadRef.current = false;
    /** Only the first swallowed keystroke gets a message; the rest stay quiet. */
    let saidDead = false;
    const sayDead = () => {
      if (saidDead || disposed) return;
      saidDead = true;
      term.write(
        "\r\n\x1b[31m[shell is gone — press Enter to start a new one]\x1b[0m\r\n",
      );
    };
    /**
     * Send bytes to the PTY, or say so once when there is nothing to send to.
     *
     * The rejection path matters as much as the flag: a close and a keystroke
     * can cross, and `pty://exit` only arrives once the reader has drained, so
     * the first thing to notice a dead terminal is often the write itself.
     */
    const writePty = (text: string) => {
      if (deadRef.current) {
        sayDead();
        return;
      }
      void ptyWrite(id, encodeBase64(encoder.encode(text))).catch(() => {
        deadRef.current = true;
        sayDead();
      });
    };
    /** Geometry is not worth a message; a dead PTY just has no geometry. */
    const resizePty = (cols: number, rows: number) => {
      if (deadRef.current) return;
      void ptyResize(id, cols, rows).catch(() => {
        deadRef.current = true;
      });
    };
    /** Spawn this terminal is bound to; events from older spawns are dropped. */
    let instance: number | null = null;
    /**
     * Output that raced ahead of ptyOpen's reply.
     *
     * The shell starts emitting as soon as the Rust side spawns it, so the
     * first `pty://data` events can land while `instance` is still null; they
     * are held here and flushed once the instance is known.
     */
    let pendingData: Array<{ instance: number; data: string }> = [];
    const disposables: Array<() => void> = [];

    // Keystrokes out. Enter into a dead terminal is the respawn gesture, so it
    // does not reach `writePty` — nothing would be listening.
    disposables.push(term.onData((data) => {
      if (deadRef.current && (data.includes("\r") || data.includes("\n"))) {
        respawn();
        return;
      }
      writePty(data);
    }).dispose);

    // Selection publishes to PRIMARY, matching every other X11 terminal.
    disposables.push(term.onSelectionChange(() => {
      const selection = term.getSelection();
      if (selection) void primarySet(selection);
    }).dispose);

    // Middle-click pastes PRIMARY into the shell.
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 1) return;
      event.preventDefault();
      if (deadRef.current) {
        sayDead();
        return;
      }
      void primaryGet().then((text) => {
        if (text) writePty(text);
      });
    };
    host.addEventListener("mousedown", onMouseDown, true);
    disposables.push(() => host.removeEventListener("mousedown", onMouseDown, true));

    // Ctrl+Shift+C / Ctrl+Shift+V, since Ctrl+C must reach the shell.
    // Not pushed onto `disposables`: this returns void, so the old code was
    // storing `undefined` and throwing on teardown.
    term.attachCustomKeyEventHandler((event) => {
        if (!event.ctrlKey || !event.shiftKey || event.type !== "keydown") return true;
        if (event.key === "C") {
          const selection = term.getSelection();
          if (selection) void navigator.clipboard.writeText(selection);
          return false;
        }
        if (event.key === "V") {
          if (deadRef.current) {
            sayDead();
            return false;
          }
          void navigator.clipboard.readText().then((text) => {
            if (text) writePty(text);
          });
          return false;
        }
      return true;
    });

    const dataSubscription = onPtyData((event) => {
      if (event.id !== id || disposed) return;
      if (instance === null) {
        pendingData.push({ instance: event.instance, data: event.data });
        return;
      }
      if (event.instance === instance) term.write(decodeBase64(event.data));
    });
    const exitSubscription = onPtyExit((event) => {
      if (event.id === id && event.instance === instance && !disposed) {
        deadRef.current = true;
        term.write("\r\n\x1b[90m[process exited — press Enter for a new shell]\x1b[0m\r\n");
      }
    });

    const opened = ptyOpen(id, cwd, term.cols, term.rows)
      .then((info) => {
        instance = info.instance;
        // Flush output that arrived while the reply was in flight, dropping
        // anything a stale spawn emitted.
        if (!disposed) {
          for (const event of pendingData) {
            if (event.instance === info.instance) term.write(decodeBase64(event.data));
          }
        }
        pendingData = [];
        return info.instance;
      })
      .catch((e) => {
        pendingData = [];
        // No PTY was ever opened, so treat the pane as dead — and count the
        // failure line as the one message, rather than adding a second.
        deadRef.current = true;
        saidDead = true;
        term.write(`\r\n\x1b[31mfailed to open terminal: ${e}\x1b[0m\r\n`);
        return null;
      });

    // Refit on container resize, and tell the PTY about the new geometry.
    //
    // `fit()` resizes the xterm canvas *inside* the observed element, so a naive
    // observer re-triggers itself on its own output and spins the main thread at
    // 100% until the window is closed. Two guards break the cycle: bail when the
    // host box has not actually moved, and only touch the PTY when the computed
    // grid changed. The rAF hop keeps the resize out of the observer callback,
    // which is what silences "ResizeObserver loop completed with undelivered
    // notifications".
    let lastWidth = 0;
    let lastHeight = 0;
    let lastCols = term.cols;
    let lastRows = term.rows;
    let frame = 0;

    const applyFit = () => {
      frame = 0;
      if (disposed) return;
      try {
        fit.fit();
        if (term.cols !== lastCols || term.rows !== lastRows) {
          lastCols = term.cols;
          lastRows = term.rows;
          resizePty(term.cols, term.rows);
        }
      } catch {
        // The element can be measured mid-teardown; a failed fit is not fatal.
      }
    };

    const observer = new ResizeObserver((records) => {
      const box = records[0]?.contentRect;
      if (box) {
        // Sub-pixel jitter is not a resize; a whole cell is.
        if (Math.abs(box.width - lastWidth) < 1 && Math.abs(box.height - lastHeight) < 1) {
          return;
        }
        lastWidth = box.width;
        lastHeight = box.height;
      }
      if (frame === 0) frame = requestAnimationFrame(applyFit);
    });
    observer.observe(host);

    return () => {
      disposed = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
      for (const dispose of disposables) {
        try {
          dispose();
        } catch {
          // attachCustomKeyEventHandler returns void in some builds.
        }
      }
      void dataSubscription.then((fn) => fn());
      void exitSubscription.then((fn) => fn());
      // Close the terminal this effect opened, not the one that replaced it.
      void opened.then((openedInstance) => {
        if (openedInstance !== null) void ptyClose(id, openedInstance);
      });
      term.dispose();
      termRef.current = null;
    };
  }, [id, cwd, generation]);

  // Repaint the canvas palette when the theme changes. `system` resolves through
  // a media query, so the token read has to happen after the swap has landed —
  // and under `system` the CSS repaints on an OS flip while the canvas keeps a
  // stale palette, so the media query is watched directly rather than relying on
  // a prop change that never comes.
  useEffect(() => {
    let frame = 0;
    const repaint = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const term = termRef.current;
        if (term) term.options.theme = readTheme();
      });
    };
    repaint();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", repaint);
    return () => {
      cancelAnimationFrame(frame);
      media.removeEventListener("change", repaint);
    };
  }, [themeKey]);

  // Take the caret when the parent asks. A frame late, because the request
  // usually arrives with the layout change that revealed this pane, and xterm
  // cannot focus a `display: none` textarea.
  useEffect(() => {
    if (!focusRequest) return;
    const frame = requestAnimationFrame(() => termRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);

  // The parent bumps this when the panel height changes.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    const frame = requestAnimationFrame(() => {
      try {
        const beforeCols = term.cols;
        const beforeRows = term.rows;
        fit.fit();
        if (!deadRef.current && (term.cols !== beforeCols || term.rows !== beforeRows)) {
          void ptyResize(id, term.cols, term.rows).catch(() => {
            deadRef.current = true;
          });
        }
      } catch {
        // Ignore transient measurement failures.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [refitToken, id]);

  return <div className="terminal-host" ref={hostRef} />;
}
