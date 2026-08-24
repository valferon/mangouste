/**
 * The interactive-only CLI commands, rebuilt on the control protocol.
 *
 * A `--print` session refuses `/permissions`, `/status` and friends because
 * they are Ink components, and answers `/model` or `/mcp` with a sentence where
 * the TUI draws a panel. Every one of them is backed by a `control_request`
 * that the headless CLI does answer, so these render the real data instead.
 *
 * Each panel fetches for itself. That keeps the transcript item immutable — it
 * only names the command — so an arriving answer re-renders one card rather
 * than the whole timeline.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  controlBinaryVersion,
  controlContextUsage,
  controlListModels,
  controlMcpReconnect,
  controlMcpStatus,
  controlMcpToggle,
  controlReloadPlugins,
  controlReloadSkills,
  controlRenameSession,
  controlSessionCost,
  controlSetModel,
  controlSetPermissionMode,
  controlSettings,
  controlUsage,
} from "../lib/control";
import { buildMenu, type NativeCommand } from "../lib/slashCommands";
import type {
  ContextUsageResult,
  ControlSettingsResult,
  ControlUsageResult,
  InitializeResult,
  McpStatusResult,
  ModelOption,
  SlashCommand,
} from "../lib/types";

export interface ControlPanelProps {
  chatId: string;
  command: NativeCommand;
  args: string;
  cwd: string;
  sessionId: string | null;
  /** Catalog from `initialize`, null until the request lands. */
  catalog: InitializeResult | null;
  /** Mode the live process is running under, as far as the pane knows. */
  permissionMode: string;
  /** A `set_model` that took effect, so the composer's switch can follow it. */
  onModelApplied: (value: string) => void;
  /** A `set_permission_mode` that took effect, for the same reason. */
  onPermissionModeApplied: (mode: string) => void;
}

/* ---------- shared plumbing ---------- */

type Loaded<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: string };

/**
 * Run one control request per mount, with a manual reload.
 *
 * `load` is called through a ref rather than tracked as a dependency: every
 * caller writes it as an inline arrow, and depending on it would re-fetch on
 * each render.
 */
function usePanelData<T>(load: () => Promise<T>): {
  state: Loaded<T>;
  reload: () => void;
  set: (data: T) => void;
} {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const [runner] = useState(() => ({ load }));
  runner.load = load;

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    runner
      .load()
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ status: "error", error: messageOf(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [nonce, runner]);

  return {
    state,
    reload: useCallback(() => setNonce((n) => n + 1), []),
    set: useCallback((data: T) => setState({ status: "ready", data }), []),
  };
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Frame({
  command,
  onReload,
  children,
}: {
  command: string;
  onReload?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="control-panel">
      <div className="cp-head">
        <span className="cp-title">/{command}</span>
        <span className="spacer" />
        {onReload && (
          <button className="toggle-button" onClick={onReload}>
            refresh
          </button>
        )}
      </div>
      <div className="cp-body">{children}</div>
    </div>
  );
}

/** Loading and error arms, so no panel has to spell them out. */
function Gate<T>({ state, children }: { state: Loaded<T>; children: (data: T) => React.ReactNode }) {
  if (state.status === "loading") return <div className="cp-note">loading…</div>;
  if (state.status === "error") return <div className="cp-error">{state.error}</div>;
  return <>{children(state.data)}</>;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

/** "in 3h 20m", or the raw stamp when it cannot be parsed. */
function formatReset(iso: string | null): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const minutes = Math.round((at - Date.now()) / 60000);
  if (minutes <= 0) return "resetting";
  if (minutes < 60) return `resets in ${minutes}m`;
  return `resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function Bar({ percent, tone }: { percent: number; tone?: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="cp-bar">
      <div className="cp-bar-fill" data-tone={tone ?? ""} style={{ width: `${clamped}%` }} />
    </div>
  );
}

/* ---------- /model ---------- */

function ModelPanel({
  chatId,
  args,
  catalog,
  onModelApplied,
}: Pick<ControlPanelProps, "chatId" | "args" | "catalog" | "onModelApplied">) {
  // `initialize` already carried the catalog, so the list renders instantly and
  // only a session that never initialized pays for a round trip.
  const seeded = catalog?.models ?? null;
  const { state, reload } = usePanelData<ModelOption[]>(() =>
    seeded ? Promise.resolve(seeded) : controlListModels(chatId).then((r) => r.models),
  );
  const [applied, setApplied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback(
    async (value: string) => {
      setBusy(true);
      setError(null);
      try {
        await controlSetModel(chatId, value === "default" ? null : value);
        setApplied(value);
        onModelApplied(value);
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setBusy(false);
      }
    },
    [chatId, onModelApplied],
  );

  // An argument is a direct switch: `/model sonnet` should not need a click.
  // Latched, because StrictMode runs mount effects twice and a later click
  // must not be undone by this one firing again.
  const auto = useRef(false);
  useEffect(() => {
    const requested = args.trim();
    if (!requested || auto.current) return;
    auto.current = true;
    void apply(requested);
  }, [args, apply]);

  return (
    <Frame command="model" onReload={reload}>
      {error && <div className="cp-error">{error}</div>}
      {applied && (
        <div className="cp-note">
          now running as <strong>{applied}</strong> — takes effect on the next turn
        </div>
      )}
      <Gate state={state}>
        {(models) => (
          <div className="cp-list">
            {models.map((model) => (
              <button
                key={model.value}
                className="cp-row cp-row-action"
                data-active={model.value === applied}
                disabled={busy}
                onClick={() => void apply(model.value)}
              >
                <span className="cp-key">{model.displayName}</span>
                <span className="cp-value">{model.description}</span>
                <code className="cp-code">{model.value}</code>
              </button>
            ))}
          </div>
        )}
      </Gate>
    </Frame>
  );
}

/* ---------- /mcp ---------- */

/** Statuses that map onto the rail's dot colours. */
const MCP_TONE: Record<string, string> = {
  connected: "finished",
  pending: "active",
  connecting: "active",
  "needs-auth": "awaiting",
  failed: "interrupted",
  disabled: "idle",
};

function McpPanel({ chatId }: { chatId: string }) {
  const { state, reload } = usePanelData<McpStatusResult>(() => controlMcpStatus(chatId));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = useCallback(
    async (name: string, run: () => Promise<unknown>) => {
      setBusy(name);
      setError(null);
      try {
        await run();
        reload();
      } catch (e) {
        setError(`${name}: ${messageOf(e)}`);
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );

  return (
    <Frame command="mcp" onReload={reload}>
      {error && <div className="cp-error">{error}</div>}
      <Gate state={state}>
        {(data) => {
          const servers = data.mcpServers ?? [];
          if (servers.length === 0) return <div className="cp-note">No MCP servers configured.</div>;
          const connected = servers.filter((s) => s.status === "connected").length;
          return (
            <>
              <div className="cp-note">
                {servers.length} servers · {connected} connected
              </div>
              <div className="cp-list">
                {servers.map((server) => (
                  <div className="cp-row" key={server.name}>
                    <span
                      className="status-dot"
                      data-status={MCP_TONE[server.status] ?? "idle"}
                      title={server.status}
                    />
                    <span className="cp-key">{server.name}</span>
                    <span className="cp-value">
                      {server.status}
                      {server.scope ? ` · ${server.scope}` : ""}
                      {server.config?.type ? ` · ${server.config.type}` : ""}
                    </span>
                    <button
                      className="toggle-button"
                      disabled={busy === server.name}
                      onClick={() =>
                        void act(server.name, () => controlMcpReconnect(chatId, server.name))
                      }
                    >
                      reconnect
                    </button>
                    <button
                      className="toggle-button"
                      disabled={busy === server.name}
                      onClick={() =>
                        void act(server.name, () =>
                          controlMcpToggle(chatId, server.name, server.status === "disabled"),
                        )
                      }
                    >
                      {server.status === "disabled" ? "enable" : "disable"}
                    </button>
                  </div>
                ))}
              </div>
            </>
          );
        }}
      </Gate>
    </Frame>
  );
}

/* ---------- /context ---------- */

function ContextPanel({ chatId }: { chatId: string }) {
  const { state, reload } = usePanelData<ContextUsageResult>(() => controlContextUsage(chatId));
  return (
    <Frame command="context" onReload={reload}>
      <Gate state={state}>
        {(data) => {
          // "Free space" is a category too; excluding it keeps every bar a share
          // of what is actually occupied.
          const used = data.categories.filter((c) => c.name !== "Free space");
          return (
            <>
              <div className="cp-headline">
                {formatTokens(data.totalTokens)} / {formatTokens(data.maxTokens)} ·{" "}
                {data.percentage}%
              </div>
              <Bar percent={data.percentage} tone={data.percentage > 80 ? "hot" : undefined} />
              <div className="cp-list">
                {used.map((category) => (
                  <div className="cp-row" key={category.name}>
                    <span className="cp-key">
                      {category.name}
                      {category.isDeferred && <span className="cp-tag">deferred</span>}
                    </span>
                    <Bar percent={(category.tokens / Math.max(1, data.maxTokens)) * 100} />
                    <code className="cp-code">{formatTokens(category.tokens)}</code>
                  </div>
                ))}
              </div>
            </>
          );
        }}
      </Gate>
    </Frame>
  );
}

/* ---------- /usage ---------- */

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5 hour",
  seven_day: "7 day",
  seven_day_opus: "7 day · Opus",
  seven_day_sonnet: "7 day · Sonnet",
  seven_day_cowork: "7 day · Cowork",
  seven_day_oauth_apps: "7 day · OAuth apps",
};

/** A rate-limit entry the panel knows how to draw. */
function asWindow(value: unknown): { utilization: number; resetsAt: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.utilization !== "number") return null;
  return {
    utilization: record.utilization,
    resetsAt: typeof record.resets_at === "string" ? record.resets_at : null,
  };
}

function UsagePanel({ chatId }: { chatId: string }) {
  const { state, reload } = usePanelData<ControlUsageResult>(() => controlUsage(chatId));
  return (
    <Frame command="usage" onReload={reload}>
      <Gate state={state}>
        {(data) => {
          const limits = data.rate_limits ?? {};
          // Named windows first, then anything else the plan reports as used —
          // the rest are windows this account does not have, reported as null.
          const rows = Object.entries(limits)
            .map(([key, value]) => ({ key, window: asWindow(value) }))
            .filter(
              (row): row is { key: string; window: { utilization: number; resetsAt: string | null } } =>
                row.window !== null && (row.key in WINDOW_LABELS || row.window.utilization > 0),
            )
            .sort(
              (a, b) =>
                Number(b.key in WINDOW_LABELS) - Number(a.key in WINDOW_LABELS) ||
                b.window.utilization - a.window.utilization,
            );
          return (
            <>
              <div className="cp-headline">
                session ${data.session.total_cost_usd.toFixed(4)} · +
                {data.session.total_lines_added}/−{data.session.total_lines_removed} lines
                {data.subscription_type ? ` · ${data.subscription_type}` : ""}
              </div>
              {!data.rate_limits_available && (
                <div className="cp-note">Plan rate limits are not reported for this account.</div>
              )}
              <div className="cp-list">
                {rows.map(({ key, window }) => (
                  <div className="cp-row" key={key}>
                    <span className="cp-key">{WINDOW_LABELS[key] ?? key}</span>
                    <Bar
                      percent={window.utilization}
                      tone={window.utilization >= 90 ? "hot" : undefined}
                    />
                    <code className="cp-code">{Math.round(window.utilization)}%</code>
                    <span className="cp-value">{formatReset(window.resetsAt)}</span>
                  </div>
                ))}
              </div>
            </>
          );
        }}
      </Gate>
    </Frame>
  );
}

/* ---------- /cost ---------- */

function CostPanel({ chatId }: { chatId: string }) {
  const { state, reload } = usePanelData<{ text: string }>(() => controlSessionCost(chatId));
  return (
    <Frame command="cost" onReload={reload}>
      <Gate state={state}>{(data) => <pre className="cp-pre selectable">{data.text}</pre>}</Gate>
    </Frame>
  );
}

/* ---------- /permissions ---------- */

const MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];

function PermissionsPanel({
  chatId,
  args,
  permissionMode,
  onPermissionModeApplied,
}: Pick<ControlPanelProps, "chatId" | "args" | "permissionMode" | "onPermissionModeApplied">) {
  const [current, setCurrent] = useState(permissionMode);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback(
    async (mode: string) => {
      setBusy(true);
      setError(null);
      try {
        const result = await controlSetPermissionMode(chatId, mode);
        const applied = result.mode ?? mode;
        setCurrent(applied);
        onPermissionModeApplied(applied);
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setBusy(false);
      }
    },
    [chatId, onPermissionModeApplied],
  );

  // Latched for the same reason as the model panel's.
  const auto = useRef(false);
  useEffect(() => {
    const requested = args.trim();
    if (!requested || auto.current) return;
    auto.current = true;
    void apply(requested);
  }, [args, apply]);

  return (
    <Frame command="permissions">
      {error && <div className="cp-error">{error}</div>}
      <div className="cp-note">
        Unlike the composer&apos;s mode switch, this applies to the running process straight away —
        no restart, no lost transcript.
      </div>
      <div className="cp-list">
        {MODES.map((mode) => (
          <button
            key={mode}
            className="cp-row cp-row-action"
            data-active={mode === current}
            disabled={busy}
            onClick={() => void apply(mode)}
          >
            <span className="cp-key">{mode}</span>
            <span className="cp-value">{mode === current ? "in effect" : ""}</span>
          </button>
        ))}
      </div>
    </Frame>
  );
}

/* ---------- /status and /version ---------- */

function SessionStatusPanel({
  chatId,
  cwd,
  sessionId,
  catalog,
  permissionMode,
}: Pick<ControlPanelProps, "chatId" | "cwd" | "sessionId" | "catalog" | "permissionMode">) {
  const { state, reload } = usePanelData(() => controlBinaryVersion(chatId));
  const account = catalog?.account ?? null;
  return (
    <Frame command="status" onReload={reload}>
      <div className="cp-list">
        <Row label="session" value={sessionId ?? "not started"} />
        <Row label="cwd" value={cwd} />
        <Row label="permission mode" value={permissionMode} />
        {catalog?.pid != null && <Row label="pid" value={String(catalog.pid)} />}
        {account?.organization && <Row label="organization" value={account.organization} />}
        {account?.subscriptionType && <Row label="plan" value={account.subscriptionType} />}
        {account?.apiProvider && <Row label="provider" value={account.apiProvider} />}
        {catalog?.output_style && <Row label="output style" value={catalog.output_style} />}
        {catalog && <Row label="commands" value={`${catalog.commands.length} available`} />}
        {catalog && <Row label="agents" value={`${catalog.agents.length} defined`} />}
        <Gate state={state}>
          {(version) => (
            <Row
              label="cli"
              value={`${version.version}${version.buildTime ? ` · built ${version.buildTime}` : ""}`}
            />
          )}
        </Gate>
      </div>
    </Frame>
  );
}

function VersionPanel({ chatId }: { chatId: string }) {
  const { state, reload } = usePanelData(() => controlBinaryVersion(chatId));
  return (
    <Frame command="version" onReload={reload}>
      <Gate state={state}>
        {(version) => (
          <div className="cp-list">
            <Row label="version" value={version.version} />
            {version.buildTime && <Row label="built" value={version.buildTime} />}
          </div>
        )}
      </Gate>
    </Frame>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="cp-row">
      <span className="cp-key">{label}</span>
      <span className="cp-value selectable">{value}</span>
    </div>
  );
}

/* ---------- /help ---------- */

function HelpPanel({ catalog }: { catalog: InitializeResult | null }) {
  const entries = useMemo(() => buildMenu(catalog?.commands ?? []), [catalog]);
  const native = entries.filter((entry) => entry.native);
  const cli = entries.filter((entry) => !entry.native);
  return (
    <Frame command="help">
      <div className="cp-note">
        Handled by mangouste — these are the CLI panels a headless session cannot open.
      </div>
      <div className="cp-list">
        {native.map((entry) => (
          <div className="cp-row" key={entry.name}>
            <span className="cp-key">
              /{entry.name} {entry.argumentHint && <em className="cp-hint">{entry.argumentHint}</em>}
            </span>
            <span className="cp-value">{entry.description}</span>
          </div>
        ))}
      </div>
      <div className="cp-note">
        Sent to the CLI — {cli.length} commands, skills and plugin prompts.
      </div>
      <div className="cp-list">
        {cli.map((entry) => (
          <div className="cp-row" key={entry.name}>
            <span className="cp-key">
              /{entry.name} {entry.argumentHint && <em className="cp-hint">{entry.argumentHint}</em>}
            </span>
            <span className="cp-value cp-clamp">{entry.description}</span>
          </div>
        ))}
      </div>
    </Frame>
  );
}

/* ---------- /config ---------- */

function ConfigPanel({ chatId }: { chatId: string }) {
  const { state, reload } = usePanelData<ControlSettingsResult>(() => controlSettings(chatId));
  return (
    <Frame command="config" onReload={reload}>
      <div className="cp-note">
        Effective settings, merged across policy, user, project, local and flag sources. Read-only —
        edit the files themselves.
      </div>
      <Gate state={state}>
        {(data) => (
          <pre className="cp-pre selectable">{JSON.stringify(data.effective ?? data, null, 2)}</pre>
        )}
      </Gate>
    </Frame>
  );
}

/* ---------- /rename ---------- */

function RenamePanel({ chatId, args }: { chatId: string; args: string }) {
  const title = args.trim();
  const { state } = usePanelData(() =>
    title
      ? controlRenameSession(chatId, title).then(() => title)
      : Promise.reject(new Error("Usage: /rename <title>")),
  );
  return (
    <Frame command="rename">
      <Gate state={state}>
        {(applied) => <div className="cp-note">Session renamed to “{String(applied)}”.</div>}
      </Gate>
    </Frame>
  );
}

/* ---------- /skills and /plugin ---------- */

function CommandListPanel({
  chatId,
  command,
}: {
  chatId: string;
  command: "skills" | "plugin";
}) {
  const { state, reload } = usePanelData<SlashCommand[]>(() =>
    command === "skills"
      ? controlReloadSkills(chatId).then((r) => r.skills ?? [])
      : controlReloadPlugins(chatId).then((r) => r.commands ?? []),
  );
  return (
    <Frame command={command} onReload={reload}>
      <div className="cp-note">Reloaded from disk.</div>
      <Gate state={state}>
        {(list) => (
          <div className="cp-list">
            {list.length === 0 && <div className="cp-note">Nothing loaded.</div>}
            {list.map((entry) => (
              <div className="cp-row" key={entry.name}>
                <span className="cp-key">/{entry.name}</span>
                <span className="cp-value cp-clamp">{entry.description}</span>
              </div>
            ))}
          </div>
        )}
      </Gate>
    </Frame>
  );
}

/* ---------- /remote-control ---------- */

function RemoteControlPanel() {
  return (
    <Frame command="remote-control">
      <div className="cp-note">
        Remote control is not reachable from this chat. It is a bridge inside the interactive REPL
        that lets claude.ai drive a terminal session — a <code>--print</code> process, which is what
        every mangouste chat is, never starts one.
      </div>
      <div className="cp-note">
        To use it, open the terminal pane, run <code>claude</code> there, and type{" "}
        <code>/remote-control</code> in that session.
      </div>
    </Frame>
  );
}

/* ---------- dispatch ---------- */

export function ControlPanel(props: ControlPanelProps) {
  const { chatId, command, args, cwd, sessionId, catalog, permissionMode } = props;
  switch (command) {
    case "model":
      return (
        <ModelPanel
          chatId={chatId}
          args={args}
          catalog={catalog}
          onModelApplied={props.onModelApplied}
        />
      );
    case "mcp":
      return <McpPanel chatId={chatId} />;
    case "context":
      return <ContextPanel chatId={chatId} />;
    case "usage":
      return <UsagePanel chatId={chatId} />;
    case "cost":
      return <CostPanel chatId={chatId} />;
    case "permissions":
      return (
        <PermissionsPanel
          chatId={chatId}
          args={args}
          permissionMode={permissionMode}
          onPermissionModeApplied={props.onPermissionModeApplied}
        />
      );
    case "status":
      return (
        <SessionStatusPanel
          chatId={chatId}
          cwd={cwd}
          sessionId={sessionId}
          catalog={catalog}
          permissionMode={permissionMode}
        />
      );
    case "version":
      return <VersionPanel chatId={chatId} />;
    case "help":
      return <HelpPanel catalog={catalog} />;
    case "config":
      return <ConfigPanel chatId={chatId} />;
    case "rename":
      return <RenamePanel chatId={chatId} args={args} />;
    case "skills":
    case "plugin":
      return <CommandListPanel chatId={chatId} command={command} />;
    case "remote-control":
      return <RemoteControlPanel />;
    default:
      // Exhaustive over NativeCommand; kept so adding one is a visible gap
      // rather than a blank card.
      return (
        <Frame command={command}>
          <div className="cp-error">No panel for /{command} yet.</div>
        </Frame>
      );
  }
}
