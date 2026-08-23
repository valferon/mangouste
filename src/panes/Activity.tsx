import { useEffect, useState } from "react";

/**
 * Whimsical verbs, in the spirit of the Claude Code CLI spinner.
 *
 * Purely decorative: the technical phase goes to the status bar. This line
 * exists so the transcript itself shows that something is happening, rather
 * than ending on a silent blank space.
 */
const VERBS = [
  "Calculating",
  "Transmuting",
  "Combobulating",
  "Percolating",
  "Ruminating",
  "Untangling",
  "Marinating",
  "Noodling",
  "Conjuring",
  "Tessellating",
  "Reticulating",
  "Germinating",
];

/** Braille spinner: one cell, no layout shift as it turns. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const FRAME_MS = 90;
/** Long enough to read, short enough to prove the UI is still alive. */
const VERB_MS = 4000;

interface ActivityProps {
  /** Shown after the verb, e.g. a running tool's name. */
  detail?: string | null;
  /** When the turn started, for the elapsed counter. */
  startedAt?: number | null;
  /** Second line: the process actually executing right now, from the probe. */
  sub?: string | null;
}

export function Activity({ detail, startedAt, sub }: ActivityProps) {
  const [frame, setFrame] = useState(0);
  const [verb, setVerb] = useState(() => Math.floor(Math.random() * VERBS.length));

  useEffect(() => {
    const spin = window.setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), FRAME_MS);
    // Advance rather than re-randomise, so the same word never repeats twice.
    const rotate = window.setInterval(
      () => setVerb((v) => (v + 1 + Math.floor(Math.random() * (VERBS.length - 1))) % VERBS.length),
      VERB_MS,
    );
    return () => {
      window.clearInterval(spin);
      window.clearInterval(rotate);
    };
  }, []);

  // Derived from the spinner's own re-render, so no second timer is needed.
  const seconds = startedAt != null ? Math.floor((Date.now() - startedAt) / 1000) : null;

  return (
    <div className="activity" aria-live="polite">
      <span className="activity-spinner">{FRAMES[frame]}</span>
      <span className="activity-verb">{VERBS[verb]}…</span>
      {detail && <span className="activity-detail">{detail}</span>}
      {seconds !== null && seconds > 0 && (
        <span className="activity-elapsed">{seconds}s</span>
      )}
      <span className="activity-hint">esc to interrupt</span>
      {sub && <span className="activity-sub">└ {sub}</span>}
    </div>
  );
}
