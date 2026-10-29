import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toolOutputTail, type OutputTail } from "../lib/ipc";

/** Lines kept in view. Enough to scroll back through an ansible play. */
const FOLLOW_LINES = 400;
const POLL_MS = 1000;
/** Within this many pixels of the end counts as "at the end": keep pinned. */
const PIN_SLACK = 24;

interface OutputFollowProps {
  /** The output file, as the probe or a backgrounded call's result named it. */
  path: string;
  /** Header label; the file name when absent. */
  label?: string | null;
  /** Shown while the file is still empty, in place of "(no output yet)". */
  emptyText?: string | null;
  onClose?: () => void;
}

/**
 * A running command's output, followed live.
 *
 * Polls the file rather than streaming it: the probe that found it ticks once
 * a second anyway, and a log meant for human eyes gains nothing from faster.
 * Stays pinned to the end while you are at the end, and stops moving the
 * moment you scroll up to read something.
 */
export function OutputFollow({ path, label, emptyText, onClose }: OutputFollowProps) {
  const [tail, setTail] = useState<OutputTail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const bodyRef = useRef<HTMLPreElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      toolOutputTail(path, FOLLOW_LINES).then(
        (next) => {
          if (cancelled) return;
          setError(next === null ? "output file is gone" : null);
          // Same bytes, same text: skip the render so a scrolled view holds still.
          setTail((previous) =>
            next !== null &&
            previous !== null &&
            previous.bytes === next.bytes &&
            previous.mtimeMs === next.mtimeMs
              ? previous
              : next,
          );
          setNow(Date.now());
        },
        (reason) => {
          if (!cancelled) setError(String(reason));
        },
      );
    };
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [path]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body && pinnedRef.current) body.scrollTop = body.scrollHeight;
  }, [tail]);

  const name = label || path.split("/").pop() || path;
  const quiet = tail ? Math.max(0, Math.floor((now - tail.mtimeMs) / 1000)) : null;

  return (
    <div className="output-follow" onClick={(event) => event.stopPropagation()}>
      <div className="output-follow-head" title={path}>
        <span className="output-follow-name">{name}</span>
        {tail && <span className="output-follow-meta">{formatBytes(tail.bytes)}</span>}
        {quiet !== null && (
          <span className="output-follow-meta">
            {quiet < 2 ? "writing" : `quiet ${formatAge(quiet)}`}
          </span>
        )}
        {onClose && (
          <button type="button" className="output-follow-close" onClick={onClose} title="Stop following">
            ×
          </button>
        )}
      </div>
      <pre
        ref={bodyRef}
        className="output-follow-body selectable"
        onScroll={(event) => {
          const el = event.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK;
        }}
      >
        {error ?? (tail === null ? "…" : tail.text || emptyText || "(no output yet)")}
      </pre>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}
