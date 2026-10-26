import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pluginAction, pluginCatalog, pluginList, pluginMarketplaces } from "../lib/ipc";
import {
  PLUGIN_SCOPES,
  alreadyDone,
  announcePluginsChanged,
  browsePlugins,
  isWritableScope,
  runMessage,
  shownCommandOf,
  splitPluginId,
  type AvailablePlugin,
  type InstalledPlugin,
  type Marketplace,
  type PluginAction,
  type PluginScope,
} from "../lib/plugins";

type View = "installed" | "browse" | "marketplaces";

interface PluginsPanelProps {
  /** The repo whose project and local scopes count. Null outside a repo. */
  cwd: string | null;
}

/** Actions that change what a running session has loaded. */
const RELOADS: ReadonlySet<PluginAction> = new Set([
  "install",
  "uninstall",
  "update",
  "enable",
  "disable",
  "marketplace-remove",
]);

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Settings ▸ Plugins: what is installed, the marketplaces' catalogs, and the
 * marketplaces themselves, all through the `claude plugin` CLI.
 */
export function PluginsPanel({ cwd }: PluginsPanelProps) {
  const [view, setView] = useState<View>("installed");
  const [installed, setInstalled] = useState<InstalledPlugin[] | null>(null);
  const [marketplaces, setMarketplaces] = useState<Marketplace[] | null>(null);
  /** Loaded the first time Browse opens: it reads every marketplace's catalog. */
  const [catalog, setCatalog] = useState<AvailablePlugin[] | null>(null);
  /** The last catalog read failed; Browse offers a retry instead of waiting. */
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [status, setStatus] = useState<{ text: string; failed: boolean } | null>(null);
  /** Keys of rows with a CLI run in flight. */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [marketFilter, setMarketFilter] = useState("");
  const [installScope, setInstallScope] = useState<PluginScope>("user");
  const [source, setSource] = useState("");
  const [sourceScope, setSourceScope] = useState<PluginScope>("user");

  const refreshInstalled = useCallback(
    () =>
      pluginList(cwd)
        .then(setInstalled)
        .catch((e) => setStatus({ text: `could not list plugins: ${errorText(e)}`, failed: true })),
    [cwd],
  );
  const refreshMarketplaces = useCallback(
    () =>
      pluginMarketplaces(cwd)
        .then(setMarketplaces)
        .catch((e) =>
          setStatus({ text: `could not list marketplaces: ${errorText(e)}`, failed: true }),
        ),
    [cwd],
  );
  /** One catalog read at a time: each is seconds of CLI and megabytes of JSON. */
  const catalogLoading = useRef(false);
  const refreshCatalog = useCallback(() => {
    if (catalogLoading.current) return Promise.resolve();
    catalogLoading.current = true;
    setCatalogFailed(false);
    return pluginCatalog(cwd)
      .then((result) => {
        setCatalog(result.available);
        setInstalled(result.installed);
      })
      .catch((e) => {
        setCatalogFailed(true);
        setStatus({ text: `could not read catalogs: ${errorText(e)}`, failed: true });
      })
      .finally(() => {
        catalogLoading.current = false;
      });
  }, [cwd]);

  useEffect(() => {
    void refreshInstalled();
    void refreshMarketplaces();
  }, [refreshInstalled, refreshMarketplaces]);

  useEffect(() => {
    if (view === "browse" && catalog === null && !catalogFailed) void refreshCatalog();
  }, [view, catalog, catalogFailed, refreshCatalog]);

  // Outside a repo only `user` means anything: `project` and `local` would
  // have no repo to write to, and the backend refuses them.
  useEffect(() => {
    if (cwd) return;
    setInstallScope("user");
    setSourceScope("user");
  }, [cwd]);

  // A filter on a marketplace that has since been removed would match nothing.
  useEffect(() => {
    if (marketFilter && marketplaces && !marketplaces.some((m) => m.name === marketFilter)) {
      setMarketFilter("");
    }
  }, [marketFilter, marketplaces]);

  /**
   * Run one action, and if the CLI holds it back to show a command, ask before
   * sending that command's fingerprint back. Nothing runs that a person did not
   * see first: the fingerprint accepts exactly the command shown.
   */
  const act = useCallback(
    async (
      key: string,
      action: PluginAction,
      target: string,
      scope?: PluginScope,
    ): Promise<boolean> => {
      setBusy((current) => new Set(current).add(key));
      setStatus({ text: `${action} ${target || "all"}…`, failed: false });
      try {
        let run = await pluginAction(action, target, { scope, cwd });
        const shown = run.ok ? null : shownCommandOf(run);
        if (shown) {
          const approved = window.confirm(
            `${target} is installed by running a command its marketplace declares:\n\n${shown.text}\n\nRun it?`,
          );
          if (!approved) {
            setStatus({ text: `${action} ${target}: not run`, failed: false });
            return false;
          }
          run = await pluginAction(action, target, { scope, cwd, acceptCommand: shown.sha256 });
        }
        const done = run.ok || alreadyDone(run);
        setStatus({ text: runMessage(run), failed: !done });
        if (!done) return false;
        if (RELOADS.has(action)) void announcePluginsChanged();
        if (action.startsWith("marketplace-")) {
          // The catalogs moved; Browse reads them again the next time it shows.
          void refreshMarketplaces();
          void refreshInstalled();
          setCatalog(null);
        } else if (view === "browse") {
          void refreshCatalog();
        } else {
          void refreshInstalled();
        }
        return true;
      } catch (e) {
        setStatus({ text: `${action} ${target}: ${errorText(e)}`, failed: true });
        return false;
      } finally {
        setBusy((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [cwd, view, refreshCatalog, refreshInstalled, refreshMarketplaces],
  );

  /**
   * Marketplace actions run one at a time: an "update all" and a remove of the
   * same marketplace would be two CLI runs writing the same state.
   */
  const marketBusy = [...busy].some((key) => key.startsWith("market:"));

  const installedIds = useMemo(() => new Set((installed ?? []).map((p) => p.id)), [installed]);
  const browse = useMemo(
    () => browsePlugins(catalog ?? [], installedIds, query, marketFilter),
    [catalog, installedIds, query, marketFilter],
  );

  const uninstall = (plugin: InstalledPlugin) => {
    if (!isWritableScope(plugin.scope)) return;
    if (!window.confirm(`Uninstall ${plugin.id}? Its saved data directory is removed too.`)) return;
    void act(plugin.id, "uninstall", plugin.id, plugin.scope);
  };

  const removeMarketplace = (name: string) => {
    if (!window.confirm(`Remove the marketplace ${name}? Plugins installed from it stop updating.`))
      return;
    void act(`market:${name}`, "marketplace-remove", name);
  };

  return (
    <div className="plugins-panel">
      <div className="setting-row">
        <div className="segmented">
          {(["installed", "browse", "marketplaces"] as View[]).map((option) => (
            <button key={option} data-active={view === option} onClick={() => setView(option)}>
              {option}
            </button>
          ))}
        </div>
      </div>

      {status && (
        <p className="setting-hint plugins-status" data-failed={status.failed}>
          {status.text}
        </p>
      )}

      {view === "installed" && (
        <div className="plugins-list">
          {installed === null && <p className="setting-hint">Reading plugins…</p>}
          {installed?.length === 0 && <p className="setting-hint">No plugins installed.</p>}
          {installed?.map((plugin) => {
            const { name, marketplace } = splitPluginId(plugin.id);
            const writable = isWritableScope(plugin.scope);
            const working = busy.has(plugin.id);
            const scope = writable ? (plugin.scope as PluginScope) : undefined;
            return (
              <div className="plugin-row" key={`${plugin.id}:${plugin.scope}`}>
                <div className="plugin-main">
                  <span className="plugin-name">{name}</span>
                  <span className="plugin-meta">
                    {marketplace}
                    {plugin.version && ` · ${plugin.version}`} · {plugin.scope}
                  </span>
                  {plugin.notes?.map((note) => (
                    <span className="plugin-note" key={note}>
                      {note}
                    </span>
                  ))}
                </div>
                <div className="plugin-actions">
                  <div className="segmented">
                    <button
                      data-active={plugin.enabled}
                      disabled={working || plugin.enabled}
                      onClick={() => void act(plugin.id, "enable", plugin.id, scope)}
                    >
                      on
                    </button>
                    <button
                      data-active={!plugin.enabled}
                      disabled={working || !plugin.enabled}
                      onClick={() => void act(plugin.id, "disable", plugin.id, scope)}
                    >
                      off
                    </button>
                  </div>
                  <button
                    className="plugin-button"
                    disabled={working || !writable}
                    title={writable ? "Update to the marketplace's latest version" : `${plugin.scope} plugins are managed for you`}
                    onClick={() => void act(plugin.id, "update", plugin.id, scope)}
                  >
                    update
                  </button>
                  <button
                    className="plugin-button"
                    disabled={working || !writable}
                    title={writable ? "Uninstall" : `${plugin.scope} plugins are managed for you`}
                    onClick={() => uninstall(plugin)}
                  >
                    remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {view === "browse" && (
        <>
          <div className="setting-row plugins-filters">
            <input
              value={query}
              placeholder="Search plugins"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select value={marketFilter} onChange={(event) => setMarketFilter(event.target.value)}>
              <option value="">every marketplace</option>
              {(marketplaces ?? []).map((market) => (
                <option key={market.name} value={market.name}>
                  {market.name}
                </option>
              ))}
            </select>
            <select
              value={installScope}
              title="Where an install goes"
              onChange={(event) => setInstallScope(event.target.value as PluginScope)}
            >
              {PLUGIN_SCOPES.map((scope) => (
                <option key={scope} value={scope} disabled={scope !== "user" && !cwd}>
                  {scope}
                </option>
              ))}
            </select>
          </div>
          <div className="plugins-list">
            {catalog === null && !catalogFailed && (
              <p className="setting-hint">Reading the marketplaces' catalogs…</p>
            )}
            {catalogFailed && (
              <p className="setting-hint">
                The catalogs could not be read.{" "}
                <button className="plugin-button" onClick={() => void refreshCatalog()}>
                  retry
                </button>
              </p>
            )}
            {catalog !== null && browse.total === 0 && (
              <p className="setting-hint">Nothing matches.</p>
            )}
            {browse.rows.map((plugin) => (
              <div className="plugin-row" key={plugin.pluginId}>
                <div className="plugin-main">
                  <span className="plugin-name">{plugin.name}</span>
                  <span className="plugin-meta">
                    {plugin.marketplaceName}
                    {plugin.installCount !== undefined &&
                      ` · ${plugin.installCount.toLocaleString()} installs`}
                  </span>
                  {plugin.description && (
                    <span className="plugin-description" title={plugin.description}>
                      {plugin.description}
                    </span>
                  )}
                </div>
                <div className="plugin-actions">
                  <button
                    className="plugin-button"
                    disabled={busy.has(plugin.pluginId)}
                    onClick={() => void act(plugin.pluginId, "install", plugin.pluginId, installScope)}
                  >
                    {busy.has(plugin.pluginId) ? "installing…" : "install"}
                  </button>
                </div>
              </div>
            ))}
            {browse.total > browse.rows.length && (
              <p className="setting-hint">
                {browse.total - browse.rows.length} more; narrow the search to see them.
              </p>
            )}
          </div>
        </>
      )}

      {view === "marketplaces" && (
        <>
          <div className="plugins-list">
            {marketplaces === null && <p className="setting-hint">Reading marketplaces…</p>}
            {marketplaces?.map((market) => {
              const key = `market:${market.name}`;
              return (
                <div className="plugin-row" key={market.name}>
                  <div className="plugin-main">
                    <span className="plugin-name">{market.name}</span>
                    <span className="plugin-meta">
                      {market.repo ?? market.url ?? market.path ?? market.source}
                    </span>
                  </div>
                  <div className="plugin-actions">
                    <button
                      className="plugin-button"
                      disabled={marketBusy}
                      onClick={() => void act(key, "marketplace-update", market.name)}
                    >
                      update
                    </button>
                    <button
                      className="plugin-button"
                      disabled={marketBusy}
                      onClick={() => removeMarketplace(market.name)}
                    >
                      remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="setting-row plugins-filters">
            <input
              value={source}
              placeholder="owner/repo, git URL or path"
              spellCheck={false}
              onChange={(event) => setSource(event.target.value)}
            />
            <select
              value={sourceScope}
              title="Where the marketplace is declared"
              onChange={(event) => setSourceScope(event.target.value as PluginScope)}
            >
              {PLUGIN_SCOPES.map((scope) => (
                <option key={scope} value={scope} disabled={scope !== "user" && !cwd}>
                  {scope}
                </option>
              ))}
            </select>
            <button
              className="plugin-button"
              disabled={!source.trim() || marketBusy}
              onClick={() =>
                void act("market:add", "marketplace-add", source.trim(), sourceScope).then(
                  (added) => added && setSource(""),
                )
              }
            >
              add
            </button>
            <button
              className="plugin-button"
              disabled={marketBusy}
              title="Pull every marketplace's catalog"
              onClick={() => void act("market:all", "marketplace-update", "")}
            >
              update all
            </button>
          </div>
        </>
      )}

      <p className="setting-hint">
        Runs the <code>claude plugin</code> CLI, the same as <code>/plugin</code> in a terminal.
        Open sessions reload their plugins after a change; an update may still want a restart.{" "}
        <code>project</code> and <code>local</code> apply to the repo in front.
      </p>
    </div>
  );
}
