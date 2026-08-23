import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onSessionsChanged, statsSummary } from "../lib/ipc";
import { ArchiveIcon, RefreshIcon, RepoIcon, StatusGlyph } from "../lib/icons";
import { useFlags } from "../lib/sessionFlagsContext";
import type {
  DayStat,
  McpStat,
  ProjectGroup,
  SessionMeta,
  SessionStats,
  StatsSummary,
  TokenTotals,
} from "../lib/types";

interface DashboardProps {
  /** The sidebar's scan, for titles and live status the token scan has no view of. */
  groups: ProjectGroup[];
  /** Opening a row resumes that session in a chat tab. */
  onResume: (session: SessionMeta) => void;
  /** Clicking a repo switches the rest of the workbench to it. */
  onSelectRepo: (cwd: string) => void;
}

/** Refreshes coalesce: a streaming turn fires the watcher every 1.5s. */
const REFRESH_THROTTLE_MS = 20_000;

/** Day windows for the activity chart. `0` means every day on record. */
const RANGES = [30, 90, 0] as const;
type Range = (typeof RANGES)[number];
type Metric = "cost" | "tokens";
type SortKey = "recent" | "cost" | "tokens" | "turns";

function compact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function usd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(2)}k`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(3)}`;
  return "$0";
}

function shortAge(ms: number): string {
  if (!ms) return "—";
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function bytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
  return `${n} B`;
}

/** Cache reads as a share of everything that entered the context window. */
function cacheHitRate(tokens: TokenTotals): number {
  const inbound = tokens.input + tokens.cacheWrite + tokens.cacheRead;
  return inbound > 0 ? (tokens.cacheRead / inbound) * 100 : 0;
}

/** Model id trimmed to what distinguishes it — the date suffix never does. */
function shortModel(model: string | null): string {
  if (!model) return "—";
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/**
 * One headline number.
 *
 * A stat tile rather than a one-bar chart: these are single current values, and
 * the `note` line carries the context a chart would have spent an axis on.
 */
function Tile({
  label,
  value,
  note,
  hero,
}: {
  label: string;
  value: string;
  note?: string;
  hero?: boolean;
}) {
  return (
    <div className="stat-tile" data-hero={hero || undefined}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {note && (
        <span className="tile-note" title={note}>
          {note}
        </span>
      )}
    </div>
  );
}

/**
 * A share bar: one magnitude against the largest in its column.
 *
 * Single hue, single series — the row's own text carries the value, so the bar
 * only has to answer "how big is this compared with the biggest one".
 */
function ShareBar({ value, max, title }: { value: number; max: number; title: string }) {
  const percent = max > 0 ? Math.max(value > 0 ? 2 : 0, (value / max) * 100) : 0;
  return (
    <span className="share-track" title={title}>
      <span className="share-fill" style={{ width: `${percent}%` }} />
    </span>
  );
}

/**
 * Daily activity, one bar per calendar day.
 *
 * Days with no sessions are still rendered as empty slots: a chart that skips
 * them compresses a quiet fortnight into nothing and lies about the cadence.
 * Only the peak is labelled — a number on every bar goes unread.
 */
function DayChart({ days, metric }: { days: DayStat[]; metric: Metric }) {
  const value = useCallback(
    (day: DayStat) => (metric === "cost" ? day.tokens.costUsd : day.tokens.total),
    [metric],
  );
  const filled = useMemo(() => {
    if (days.length === 0) return [];
    const byDay = new Map(days.map((day) => [day.day, day]));
    const first = Date.parse(`${days[0].day}T00:00:00Z`);
    const last = Date.parse(`${days[days.length - 1].day}T00:00:00Z`);
    const out: { day: string; stat: DayStat | null }[] = [];
    for (let at = first; at <= last; at += 86_400_000) {
      const key = new Date(at).toISOString().slice(0, 10);
      out.push({ day: key, stat: byDay.get(key) ?? null });
    }
    return out;
  }, [days]);

  const peak = useMemo(
    () => filled.reduce((best, slot) => Math.max(best, slot.stat ? value(slot.stat) : 0), 0),
    [filled, value],
  );
  const peakDay = filled.find((slot) => slot.stat && value(slot.stat) === peak);

  if (filled.length === 0) return <div className="empty-note">No dated turns yet.</div>;

  const label = (n: number) => (metric === "cost" ? usd(n) : compact(n));

  return (
    <div className="day-chart">
      <div className="chart-axis">
        <span>{label(peak)}</span>
        <span>{label(peak / 2)}</span>
        <span>0</span>
      </div>
      <div className="chart-plot" data-dense={filled.length > 120 || undefined}>
        {filled.map((slot) => {
          const amount = slot.stat ? value(slot.stat) : 0;
          const height = peak > 0 ? (amount / peak) * 100 : 0;
          return (
            <span
              key={slot.day}
              className="chart-col"
              data-empty={amount === 0 || undefined}
              title={
                slot.stat
                  ? `${slot.day} — ${usd(slot.stat.tokens.costUsd)}, ${compact(
                      slot.stat.tokens.total,
                    )} tokens, ${slot.stat.tokens.turns} turns`
                  : `${slot.day} — nothing`
              }
            >
              <span className="chart-bar" style={{ height: `${Math.max(height, amount > 0 ? 2 : 0)}%` }} />
            </span>
          );
        })}
      </div>
      <div className="chart-foot">
        <span>{filled[0].day}</span>
        {peakDay && (
          <span className="chart-peak">
            peak {peakDay.day} · {label(peak)}
          </span>
        )}
        <span>{filled[filled.length - 1].day}</span>
      </div>
    </div>
  );
}

/** MCP servers, with their per-tool call counts one click away. */
function McpTable({ rows, unused }: { rows: McpStat[]; unused: string[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const max = rows.reduce((best, row) => Math.max(best, row.calls), 0);

  if (rows.length === 0 && unused.length === 0) {
    return <div className="empty-note">No MCP tool calls on record.</div>;
  }

  return (
    <div className="dash-table">
      {rows.map((row) => (
        <div key={row.server}>
          <div
            className="dash-row"
            data-clickable="true"
            onClick={() => setOpen((current) => (current === row.server ? null : row.server))}
          >
            <span className="cell-name">{row.server}</span>
            <span className="cell-bar">
              <ShareBar value={row.calls} max={max} title={`${row.calls} calls`} />
            </span>
            <span className="cell-num">{row.calls}</span>
            <span
              className="cell-tag"
              title={
                row.configured
                  ? "Listed in ~/.claude.json"
                  : "Not in ~/.claude.json — a removed server, or a claude.ai connector, which is configured elsewhere"
              }
            >
              {row.configured ? "configured" : "—"}
            </span>
          </div>
          {open === row.server &&
            row.tools.map((tool) => (
              <div key={tool.name} className="dash-row" data-nested="true">
                <span className="cell-name">{tool.name}</span>
                <span className="cell-bar">
                  <ShareBar value={tool.count} max={row.calls} title={`${tool.count} calls`} />
                </span>
                <span className="cell-num">{tool.count}</span>
                <span className="cell-tag" />
              </div>
            ))}
        </div>
      ))}
      {unused.length > 0 && (
        <div className="empty-note">
          Configured but never called: {unused.join(", ")}. Each one still costs context on
          every startup.
        </div>
      )}
    </div>
  );
}

/**
 * Everything the transcripts add up to, across every repo and every session.
 *
 * The sessions rail answers "what is happening now"; this answers "where has the
 * work gone". Numbers come from a full read of every transcript — see
 * `stats.rs` — so they are totals, not samples, and archived sessions are in
 * them by default: archiving is a statement about attention, not about spend.
 */
export const Dashboard = memo(function Dashboard({
  groups,
  onResume,
  onSelectRepo,
}: DashboardProps) {
  const [stats, setStats] = useState<StatsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [metric, setMetric] = useState<Metric>("cost");
  const [range, setRange] = useState<Range>(30);
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("recent");
  const [showArchived, setShowArchived] = useState(true);
  const [sessionLimit, setSessionLimit] = useState(50);

  const flags = useFlags();
  const inFlight = useRef(false);
  const lastRefresh = useRef(0);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      setStats(await statsSummary());
      setError(null);
      lastRefresh.current = Date.now();
    } catch (e) {
      setError(String(e));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // The scan is incremental, but a re-render of every table is not: a
    // streaming turn fires this watcher every 1.5s, so it is throttled hard.
    const unlisten = onSessionsChanged(() => {
      if (Date.now() - lastRefresh.current < REFRESH_THROTTLE_MS) return;
      void refresh();
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [refresh]);

  /** Sidebar metadata by session id, for titles and live status. */
  const metaById = useMemo(() => {
    const map = new Map<string, SessionMeta>();
    for (const group of groups) {
      for (const session of group.sessions) map.set(session.id, session);
    }
    return map;
  }, [groups]);

  const days = useMemo(() => {
    if (!stats) return [];
    if (range === 0) return stats.days;
    const cutoff = new Date(Date.now() - range * 86_400_000).toISOString().slice(0, 10);
    return stats.days.filter((day) => day.day >= cutoff);
  }, [stats, range]);

  /** Totals over the charted window, so the chart and its caption agree. */
  const windowTotals = useMemo(() => {
    return days.reduce(
      (sum, day) => ({
        cost: sum.cost + day.tokens.costUsd,
        tokens: sum.tokens + day.tokens.total,
        turns: sum.turns + day.tokens.turns,
      }),
      { cost: 0, tokens: 0, turns: 0 },
    );
  }, [days]);

  const sessionRows = useMemo(() => {
    if (!stats) return [];
    const needle = query.trim().toLowerCase();
    const rows = stats.sessions.filter((row) => {
      if (repoFilter && row.projectDir !== repoFilter) return false;
      if (!showArchived && flags.isArchived(row.id)) return false;
      if (!needle) return true;
      const meta = metaById.get(row.id);
      const haystack = `${meta?.title ?? ""} ${row.id} ${row.cwd ?? ""} ${row.model ?? ""}`;
      return haystack.toLowerCase().includes(needle);
    });
    const sorted = [...rows];
    sorted.sort((a, b) => {
      switch (sortKey) {
        case "cost":
          return b.tokens.costUsd - a.tokens.costUsd;
        case "tokens":
          return b.tokens.total - a.tokens.total;
        case "turns":
          return b.tokens.turns - a.tokens.turns;
        default:
          return b.lastMs - a.lastMs;
      }
    });
    return sorted;
  }, [stats, query, repoFilter, showArchived, flags, metaById, sortKey]);

  /** Filtered-set totals: the caption under a filtered table must match it. */
  const shownTotals = useMemo(
    () =>
      sessionRows.reduce(
        (sum, row) => ({
          cost: sum.cost + row.tokens.costUsd,
          tokens: sum.tokens + row.tokens.total,
        }),
        { cost: 0, tokens: 0 },
      ),
    [sessionRows],
  );

  const openSession = useCallback(
    (row: SessionStats) => {
      const meta = metaById.get(row.id);
      if (meta) {
        onResume(meta);
        return;
      }
      // A transcript the sidebar scan skipped still has enough on it to resume.
      onResume({
        id: row.id,
        file: row.file,
        projectDir: row.projectDir,
        cwd: row.cwd,
        gitBranch: null,
        title: null,
        lastPrompt: null,
        model: row.model,
        version: null,
        modifiedMs: row.lastMs,
        lastActivityMs: row.lastMs,
        sizeBytes: row.sizeBytes,
        status: "idle",
        messageCount: 0,
        messageCountExact: false,
        runningAgents: [],
        runningWorkflows: [],
      });
    },
    [metaById, onResume],
  );

  if (error && !stats) {
    return (
      <div className="dashboard">
        <div className="pane-header">
          <span>Dashboard</span>
          <div className="actions">
            <button className="icon-button" onClick={() => void refresh()} title="Retry">
              <RefreshIcon />
            </button>
          </div>
        </div>
        <div className="empty-note">{error}</div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="dashboard">
        <div className="pane-header">
          <span>Dashboard</span>
        </div>
        <div className="empty-note">Reading every transcript…</div>
      </div>
    );
  }

  const totals = stats.tokens;
  const savings = totals.noCacheCostUsd - totals.costUsd;
  const projectMax = stats.projects.reduce(
    (best, project) => Math.max(best, project.tokens.costUsd),
    0,
  );
  const modelMax = stats.models.reduce((best, model) => Math.max(best, model.tokens.costUsd), 0);
  const toolMax = stats.tools.reduce((best, tool) => Math.max(best, tool.count), 0);
  const archivedShown = sessionRows.filter((row) => flags.isArchived(row.id)).length;

  return (
    <div className="dashboard">
      <div className="pane-header">
        <span>Dashboard</span>
        <span className="count">
          {stats.sessionCount} sessions · {stats.projects.length} repos ·{" "}
          {stats.agentFileCount} agent logs · {bytes(stats.sizeBytes)} scanned in{" "}
          {stats.scanMs}ms
        </span>
        <div className="actions">
          <button
            className="icon-button"
            data-active={loading}
            onClick={() => void refresh()}
            title="Rescan transcripts"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>

      <div className="dashboard-body">
        <div className="tile-row">
          <Tile
            hero
            label="Estimated API cost"
            value={usd(totals.costUsd)}
            note="at list prices — a subscription bills flat"
          />
          <Tile
            label="Tokens"
            value={compact(totals.total)}
            note={`${compact(totals.input)} in · ${compact(totals.output)} out`}
          />
          <Tile
            label="Turns"
            value={compact(totals.turns)}
            note={`${compact(totals.thinking)} thinking tokens`}
          />
          <Tile
            label="Cache hit rate"
            value={`${cacheHitRate(totals).toFixed(1)}%`}
            note={`${compact(totals.cacheRead)} read · ${compact(totals.cacheWrite)} written`}
          />
          <Tile
            label="Saved by caching"
            value={usd(savings)}
            note={`vs ${usd(totals.noCacheCostUsd)} uncached`}
          />
          <Tile
            label="Tool calls"
            value={compact(stats.tools.reduce((sum, tool) => sum + tool.count, 0))}
            note={`${compact(stats.mcp.reduce((sum, row) => sum + row.calls, 0))} via MCP`}
          />
        </div>

        <div className="dash-section">
          <div className="section-head">
            <span className="section-title">Daily activity</span>
            <div className="segmented">
              {(["cost", "tokens"] as Metric[]).map((option) => (
                <button
                  key={option}
                  data-active={metric === option}
                  onClick={() => setMetric(option)}
                >
                  {option}
                </button>
              ))}
            </div>
            <div className="segmented">
              {RANGES.map((option) => (
                <button
                  key={option}
                  data-active={range === option}
                  onClick={() => setRange(option)}
                >
                  {option === 0 ? "all" : `${option}d`}
                </button>
              ))}
            </div>
            <span className="section-note" title="Days are bucketed by UTC date">
              {usd(windowTotals.cost)} · {compact(windowTotals.tokens)} tokens ·{" "}
              {compact(windowTotals.turns)} turns
            </span>
          </div>
          <DayChart days={days} metric={metric} />
        </div>

        <div className="dash-section">
          <div className="section-head">
            <span className="section-title">Repos</span>
            {repoFilter && (
              <button className="toggle-button" onClick={() => setRepoFilter(null)}>
                clear filter
              </button>
            )}
          </div>
          <div className="dash-table">
            <div className="dash-row head">
              <span className="cell-name">repo</span>
              <span className="cell-bar">share of cost</span>
              <span className="cell-num">cost</span>
              <span className="cell-num">tokens</span>
              <span className="cell-num">turns</span>
              <span className="cell-num">sessions</span>
              <span className="cell-num">cache</span>
              <span className="cell-num">last</span>
            </div>
            {stats.projects.map((project) => (
              <div
                key={project.dirName}
                className="dash-row"
                data-clickable="true"
                data-selected={repoFilter === project.dirName}
                title={project.cwd}
                onClick={() => {
                  setRepoFilter(project.dirName);
                  onSelectRepo(project.cwd);
                }}
              >
                <span className="cell-name">
                  <RepoIcon /> {project.label}
                </span>
                <span className="cell-bar">
                  <ShareBar
                    value={project.tokens.costUsd}
                    max={projectMax}
                    title={`${usd(project.tokens.costUsd)} of ${usd(totals.costUsd)}`}
                  />
                </span>
                <span className="cell-num">{usd(project.tokens.costUsd)}</span>
                <span className="cell-num">{compact(project.tokens.total)}</span>
                <span className="cell-num">{compact(project.tokens.turns)}</span>
                <span className="cell-num">
                  {project.sessionCount}
                  {project.agentFiles > 0 && (
                    <span className="cell-sub"> +{project.agentFiles}</span>
                  )}
                </span>
                <span className="cell-num">{cacheHitRate(project.tokens).toFixed(0)}%</span>
                <span className="cell-num">{shortAge(project.lastMs)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="dash-columns">
          <div className="dash-section">
            <div className="section-head">
              <span className="section-title">Models</span>
            </div>
            <div className="dash-table">
              {stats.models.map((model) => (
                <div
                  key={model.model}
                  className="dash-row"
                  title={`${model.model} — ${compact(model.tokens.turns)} turns, ${compact(
                    model.tokens.output,
                  )} output tokens`}
                >
                  <span className="cell-name">{shortModel(model.model)}</span>
                  <span className="cell-bar">
                    <ShareBar
                      value={model.tokens.costUsd}
                      max={modelMax}
                      title={`${usd(model.tokens.costUsd)}`}
                    />
                  </span>
                  <span className="cell-num">{usd(model.tokens.costUsd)}</span>
                  <span className="cell-num">{compact(model.tokens.total)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="dash-section">
            <div className="section-head">
              <span className="section-title">MCP servers</span>
            </div>
            <McpTable rows={stats.mcp} unused={stats.unusedMcpServers} />
          </div>

          <div className="dash-section">
            <div className="section-head">
              <span className="section-title">Tools</span>
            </div>
            <div className="dash-table">
              {stats.tools.slice(0, 12).map((tool) => (
                <div key={tool.name} className="dash-row">
                  <span className="cell-name">{tool.name}</span>
                  <span className="cell-bar">
                    <ShareBar value={tool.count} max={toolMax} title={`${tool.count} calls`} />
                  </span>
                  <span className="cell-num">{tool.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="dash-section">
          <div className="section-head">
            <span className="section-title">Sessions</span>
            <input
              className="dash-search"
              placeholder="filter by title, id, path or model"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {repoFilter && (
              <button
                className="toggle-button"
                data-active="true"
                onClick={() => setRepoFilter(null)}
                title="Show every repo"
              >
                {stats.projects.find((project) => project.dirName === repoFilter)?.label ??
                  repoFilter}{" "}
                ×
              </button>
            )}
            <div className="segmented">
              {(["recent", "cost", "tokens", "turns"] as SortKey[]).map((option) => (
                <button
                  key={option}
                  data-active={sortKey === option}
                  onClick={() => setSortKey(option)}
                >
                  {option}
                </button>
              ))}
            </div>
            <button
              className="toggle-button"
              data-active={showArchived}
              onClick={() => setShowArchived((value) => !value)}
              title="Include archived sessions"
            >
              <ArchiveIcon /> archived
            </button>
            <span className="section-note">
              {sessionRows.length} shown ({archivedShown} archived) · {usd(shownTotals.cost)} ·{" "}
              {compact(shownTotals.tokens)} tokens
            </span>
          </div>
          <div className="dash-table">
            <div className="dash-row head">
              <span className="cell-glyph" />
              <span className="cell-name">session</span>
              <span className="cell-name dim">repo</span>
              <span className="cell-num">cost</span>
              <span className="cell-num">tokens</span>
              <span className="cell-num">turns</span>
              <span className="cell-num">tools</span>
              <span className="cell-num">agents</span>
              <span className="cell-num">model</span>
              <span className="cell-num">last</span>
            </div>
            {sessionRows.slice(0, sessionLimit).map((row) => {
              const meta = metaById.get(row.id);
              const status = meta ? flags.effectiveStatus(meta) : "idle";
              const archived = flags.isArchived(row.id);
              return (
                <div
                  key={row.id}
                  className="dash-row"
                  data-clickable="true"
                  data-archived={archived || undefined}
                  title={`${row.id}\n${row.cwd ?? row.projectDir}\n${compact(
                    row.tokens.cacheRead,
                  )} cache read · ${compact(row.tokens.cacheWrite)} written`}
                  onClick={() => openSession(row)}
                >
                  <span className="cell-glyph">
                    <StatusGlyph status={status} />
                  </span>
                  <span className="cell-name">
                    {meta?.title ?? `session ${row.id.slice(0, 8)}`}
                  </span>
                  <span className="cell-name dim">
                    {row.cwd?.split("/").filter(Boolean).pop() ?? row.projectDir}
                  </span>
                  <span className="cell-num">{usd(row.tokens.costUsd)}</span>
                  <span className="cell-num">{compact(row.tokens.total)}</span>
                  <span className="cell-num">{compact(row.tokens.turns)}</span>
                  <span className="cell-num">
                    {row.toolCalls}
                    {row.mcpCalls > 0 && <span className="cell-sub"> {row.mcpCalls} mcp</span>}
                  </span>
                  <span className="cell-num">
                    {row.agentFiles > 0 ? (
                      <>
                        {row.agentFiles}
                        <span className="cell-sub"> {usd(row.agentTokens.costUsd)}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </span>
                  <span className="cell-num">{shortModel(row.model)}</span>
                  <span className="cell-num">{shortAge(row.lastMs)}</span>
                </div>
              );
            })}
          </div>
          {sessionRows.length > sessionLimit && (
            <button
              className="toggle-button"
              onClick={() => setSessionLimit((limit) => limit + 100)}
            >
              show {Math.min(100, sessionRows.length - sessionLimit)} more of{" "}
              {sessionRows.length}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
