import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { fetchUsage, gitStatus } from "../lib/ipc";
import type { ClaudeUsage, ProjectGroup } from "../lib/types";
import { copyText } from "../lib/editing";
import { KEYS, readString, writeString } from "../lib/persist";
import { useMenu, type MenuEntry } from "../lib/menu";
import { useFlags } from "../lib/sessionFlagsContext";

export interface ChatStats {
  sessionId: string | null;
  model: string | null;
  /** Tokens the next request will carry: last assistant call's full window. */
  contextTokens: number;
  costUsd: number | null;
  title: string | null;
}

interface StatusPanelProps {
  groups: ProjectGroup[];
  cwd: string;
  stats: ChatStats;
}

/** Usage reads an OAuth token, so it stays opt-in and off by default. */
const USAGE_ENABLED_KEY = KEYS.prefs.usageEnabled;
const USAGE_REFRESH_MS = 5 * 60_000;

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** "3h31m/5h" style remaining-time label. */
function resetLabel(resetsAt: string | null | undefined, windowLabel: string): string {
  if (!resetsAt) return windowLabel;
  const remaining = Date.parse(resetsAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return windowLabel;
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const left = hours >= 24 ? `${Math.floor(hours / 24)}d` : hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`;
  return `${left}/${windowLabel}`;
}

function UsageBar({
  percent,
  label,
}: {
  percent: number;
  label: string;
}) {
  // Severity mirrors how the number is actually read: fine, watch it, act now.
  const severity = percent >= 90 ? "critical" : percent >= 75 ? "warn" : "ok";
  return (
    <div className="usage-row" title={`${percent}% — ${label}`}>
      <span className="usage-glyph" data-severity={severity}>
        {severity === "ok" ? "✓" : "⚠"}
      </span>
      <span className="usage-track">
        <span
          className="usage-fill"
          data-severity={severity}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </span>
      <span className="usage-pct">{percent}%</span>
      <span className="usage-label">{label}</span>
    </div>
  );
}

/**
 * Usage windows and current-session facts, above the session list.
 *
 * Everything except the usage windows is derived locally from data already in
 * the app; only the windows require a network call.
 */
export const StatusPanel = memo(function StatusPanel({ groups, cwd, stats }: StatusPanelProps) {
  const menu = useMenu();
  const [usageEnabled, setUsageEnabled] = useState(
    () => readString(USAGE_ENABLED_KEY) === "true",
  );
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const flags = useFlags();

  const refreshUsage = useCallback(async () => {
    if (!usageEnabled) return;
    try {
      setUsage(await fetchUsage());
      setUsageError(null);
    } catch (e) {
      // Keep the last good numbers; a transient failure should not blank the panel.
      setUsageError(String(e));
    }
  }, [usageEnabled]);

  useEffect(() => {
    writeString(USAGE_ENABLED_KEY, String(usageEnabled));
    if (!usageEnabled) {
      setUsage(null);
      setUsageError(null);
      return;
    }
    void refreshUsage();
    const timer = window.setInterval(() => void refreshUsage(), USAGE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [usageEnabled, refreshUsage]);

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    gitStatus(cwd)
      .then((status) => {
        if (!cancelled) setBranch(status.branch);
      })
      .catch(() => {
        if (!cancelled) setBranch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Counted through the shared overlay, not off the raw wire status: `finished`
  // and `pendingReview` are the same value from Rust, and a panel that split
  // them differently from the rail would just be a second opinion.
  const counts = useMemo(() => {
    const tally = { active: 0, awaiting: 0, pendingReview: 0, interrupted: 0, finished: 0 };
    for (const group of groups) {
      for (const session of group.sessions) {
        const status = flags.effectiveStatus(session);
        if (status in tally) tally[status as keyof typeof tally] += 1;
      }
    }
    return tally;
  }, [groups, flags]);

  /** Right-click: every fact on the panel, as something you can paste. */
  const panelMenu = useCallback(
    (): MenuEntry[] => [
      stats.title && { label: "Copy Session Title", run: () => void copyText(stats.title ?? "") },
      stats.sessionId && {
        label: "Copy Session Id",
        run: () => void copyText(stats.sessionId ?? ""),
      },
      stats.model && { label: "Copy Model", run: () => void copyText(stats.model ?? "") },
      branch && { label: "Copy Branch", run: () => void copyText(branch) },
      cwd && { label: "Copy Repository Path", run: () => void copyText(cwd) },
      "separator",
      {
        label: "Usage Windows",
        checked: usageEnabled,
        run: () => setUsageEnabled((enabled) => !enabled),
      },
      {
        label: "Refresh Usage",
        disabled: !usageEnabled,
        run: () => void refreshUsage(),
      },
    ],
    [stats, branch, cwd, usageEnabled, refreshUsage],
  );

  return (
    <div
      className="status-panel"
      onContextMenu={(event) => menu.openContextMenu(event, [...panelMenu(), "separator", "app"])}
    >
      <div className="pane-header">
        <span>Usage</span>
        <div className="actions">
          <button
            className="toggle-button"
            data-active={usageEnabled}
            onClick={() => setUsageEnabled((v) => !v)}
            title="Reads your local Claude OAuth token and calls Anthropic's usage endpoint"
          >
            {usageEnabled ? "on" : "off"}
          </button>
          {usageEnabled && (
            <button className="toggle-button" onClick={() => void refreshUsage()} title="Refresh">
              ⟳
            </button>
          )}
        </div>
      </div>

      {!usageEnabled && (
        <div className="empty-note">
          Off. Turning this on reads your local Claude OAuth token and calls
          Anthropic&apos;s usage endpoint — the same data as <code>/usage</code>.
        </div>
      )}
      {usageEnabled && usage?.fiveHour && (
        <UsageBar percent={usage.fiveHour.percent} label={resetLabel(usage.fiveHour.resetsAt, "5h")} />
      )}
      {usageEnabled && usage?.sevenDay && (
        <UsageBar percent={usage.sevenDay.percent} label={resetLabel(usage.sevenDay.resetsAt, "7d")} />
      )}
      {usageEnabled && usage?.sevenDayOpus && (
        <UsageBar percent={usage.sevenDayOpus.percent} label="7d opus" />
      )}
      {usageEnabled && usage?.sevenDaySonnet && (
        <UsageBar percent={usage.sevenDaySonnet.percent} label="7d sonnet" />
      )}
      {usageEnabled &&
        usage?.modelWindows?.map((w) => (
          <UsageBar key={w.model} percent={w.percent} label={`7d ${w.model.toLowerCase()}`} />
        ))}
      {usageEnabled && usageError && <div className="empty-note">{usageError}</div>}
      {usageEnabled && !usage && !usageError && <div className="empty-note">Loading…</div>}

      <div className="tally-row">
        <span>
          <span className="status-dot" data-status="active" /> {counts.active} active
        </span>
        <span>
          <span className="status-dot" data-status="awaiting" /> {counts.awaiting} need you
        </span>
        <span>
          <span className="status-dot" data-status="pendingReview" /> {counts.pendingReview} to
          review
        </span>
        <span>
          <span className="status-dot" data-status="interrupted" /> {counts.interrupted} cut off
        </span>
        <span>
          <span className="status-dot" data-status="finished" /> {counts.finished} done
        </span>
      </div>

      <div className="pane-header">
        <span>Current session</span>
        {stats.title && <span className="count">{stats.title}</span>}
      </div>
      <div className="fact-grid">
        <span className="fact-key">model</span>
        <span className="fact-value">{stats.model ?? "—"}</span>
        <span className="fact-key">branch</span>
        <span className="fact-value">{branch ?? "—"}</span>
        <span className="fact-key">context</span>
        <span className="fact-value">
          {stats.contextTokens > 0 ? `${compact(stats.contextTokens)} tokens` : "—"}
        </span>
        <span className="fact-key">spend</span>
        <span className="fact-value">
          {stats.costUsd !== null ? `~$${stats.costUsd.toFixed(2)}` : "—"}
        </span>
      </div>
    </div>
  );
});
