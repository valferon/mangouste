import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  clearDebug,
  cliDebugEnabled,
  debugEntries,
  debugVersion,
  setCliDebug,
  subscribeDebug,
  type DebugEntry,
} from "../lib/debugLog";

/** Rows actually rendered; the buffer behind them is larger. */
const RENDER_LIMIT = 500;

const KINDS: DebugEntry["kind"][] = [
  "frame",
  "stream",
  "stderr",
  "cli",
  "phase",
  "probe",
  "send",
  "permission",
  "exit",
  "control",
];

function clock(at: number): string {
  const d = new Date(at);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Gap to the previous row, sized for reading: ms under a second, else seconds. */
function gap(deltaMs: number): string {
  if (deltaMs <= 0) return "";
  return deltaMs < 1000 ? `+${deltaMs}ms` : `+${(deltaMs / 1000).toFixed(1)}s`;
}

const Row = memo(function Row({
  entry,
  deltaMs,
  expanded,
  onToggle,
}: {
  entry: DebugEntry;
  deltaMs: number;
  expanded: boolean;
  onToggle: (seq: number) => void;
}) {
  const expandable = entry.payload !== undefined;
  return (
    <div className="debug-row" data-kind={entry.kind}>
      <div
        className="debug-row-head"
        data-expandable={expandable}
        onClick={() => expandable && onToggle(entry.seq)}
      >
        <span className="debug-time">{clock(entry.at)}</span>
        <span className="debug-gap">{gap(deltaMs)}</span>
        <span className="debug-kind">{entry.kind}</span>
        <span className="debug-label">
          {entry.label}
          {entry.count > 1 && <span className="debug-count"> ×{entry.count}</span>}
        </span>
        {expandable && <span className="twisty">{expanded ? "▾" : "▸"}</span>}
      </div>
      {expanded && (
        <pre className="debug-payload selectable">
          {typeof entry.payload === "string"
            ? entry.payload
            : JSON.stringify(entry.payload, null, 2)}
        </pre>
      )}
    </div>
  );
});

/**
 * The session debug drawer: everything the transport did, in order, with
 * timing. Opened from the status bar's phase chip.
 */
export function DebugLog({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  // The store mutates its buffers in place; the version is the change signal.
  const version = useSyncExternalStore(subscribeDebug, debugVersion);
  const entries = debugEntries(chatId);

  const [hidden, setHidden] = useState<Set<DebugEntry["kind"]>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [verbose, setVerbose] = useState(cliDebugEnabled);

  const listRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);

  const visible = useMemo(() => {
    const filtered = hidden.size ? entries.filter((e) => !hidden.has(e.kind)) : entries;
    return filtered.length > RENDER_LIMIT ? filtered.slice(filtered.length - RENDER_LIMIT) : filtered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, hidden, version]);

  const toggleExpanded = useCallback((seq: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }, []);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    stickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  useLayoutEffect(() => {
    if (stickyRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  });

  return (
    <div className="debug-log">
      <div className="debug-head">
        <span className="debug-title">session debug</span>
        <span className="debug-meta">
          {entries.length} events{entries.length > RENDER_LIMIT ? ` · last ${RENDER_LIMIT} shown` : ""}
        </span>
        {KINDS.map((kind) => (
          <button
            key={kind}
            className="toggle-button"
            data-active={!hidden.has(kind)}
            onClick={() =>
              setHidden((current) => {
                const next = new Set(current);
                if (next.has(kind)) next.delete(kind);
                else next.add(kind);
                return next;
              })
            }
          >
            {kind}
          </button>
        ))}
        <span className="spacer" />
        <label className="debug-verbose" title="Tail the CLI's --debug-file: API requests, MCP transports, retries. Applies on restart.">
          <input
            type="checkbox"
            checked={verbose}
            onChange={(event) => {
              setVerbose(event.target.checked);
              setCliDebug(event.target.checked);
            }}
          />
          network debug (restart to apply)
        </label>
        <button className="toggle-button" onClick={() => clearDebug(chatId)}>
          clear
        </button>
        <button className="toggle-button" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="debug-list selectable" ref={listRef} onScroll={onScroll}>
        {visible.map((entry, index) => (
          <Row
            key={entry.seq}
            entry={entry}
            deltaMs={index > 0 ? entry.at - visible[index - 1].at : 0}
            expanded={expanded.has(entry.seq)}
            onToggle={toggleExpanded}
          />
        ))}
        {visible.length === 0 && <div className="debug-empty">no events yet</div>}
      </div>
    </div>
  );
}
