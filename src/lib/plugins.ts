/**
 * Claude Code plugins, as the Settings panel sees them.
 *
 * The panel drives the `claude plugin` CLI (see `plugins.rs`) and never writes
 * the plugin files itself, so this is only the shapes the CLI prints and the
 * rules for showing them. Pure, so they can be tested without the panel.
 */

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Where a plugin is installed or switched on. The panel can write these. */
export type PluginScope = "user" | "project" | "local";

export const PLUGIN_SCOPES: PluginScope[] = ["user", "project", "local"];

/** One row of `claude plugin list --json`. */
export interface InstalledPlugin {
  /** `name@marketplace`. */
  id: string;
  version?: string;
  /** A `PluginScope`, or one the panel cannot write, such as `synced` or `managed`. */
  scope: string;
  enabled: boolean;
  installPath?: string;
  installedAt?: string;
  lastUpdated?: string;
  /** Things the CLI wants said about the install, such as refused dependencies. */
  notes?: string[];
  projectEnabled?: boolean;
}

/** One row of `available` in `claude plugin list --json --available`. */
export interface AvailablePlugin {
  pluginId: string;
  name: string;
  description?: string;
  marketplaceName: string;
  installCount?: number;
}

/** One row of `claude plugin marketplace list --json`. */
export interface Marketplace {
  name: string;
  source?: string;
  repo?: string;
  url?: string;
  path?: string;
  installLocation?: string;
}

/** What `plugin_action` hands back. */
export interface PluginRun {
  ok: boolean;
  /** The CLI's result line, when it printed one. */
  result: Record<string, unknown> | null;
  message: string;
}

export type PluginAction =
  | "install"
  | "uninstall"
  | "update"
  | "enable"
  | "disable"
  | "marketplace-add"
  | "marketplace-remove"
  | "marketplace-update";

/** How many catalog rows the browse list renders at once. */
export const BROWSE_LIMIT = 60;

export function splitPluginId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf("@");
  return at <= 0
    ? { name: id, marketplace: "" }
    : { name: id.slice(0, at), marketplace: id.slice(at + 1) };
}

/**
 * Whether the panel may change this install.
 *
 * `synced` plugins come from claude.ai and `managed` ones from policy: the CLI
 * owns where they live, and an uninstall or a scoped toggle written here would
 * be undone, or refused, by whatever put them there.
 */
export const isWritableScope = (scope: string): scope is PluginScope =>
  (PLUGIN_SCOPES as string[]).includes(scope);

/**
 * Catalog rows matching `query` in name, description or marketplace, most
 * installed first, minus what is already installed.
 */
export function browsePlugins(
  available: AvailablePlugin[],
  installed: ReadonlySet<string>,
  query: string,
  marketplace: string,
  limit = BROWSE_LIMIT,
): { rows: AvailablePlugin[]; total: number } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = available.filter((plugin) => {
    if (installed.has(plugin.pluginId)) return false;
    if (marketplace && plugin.marketplaceName !== marketplace) return false;
    const haystack =
      `${plugin.name} ${plugin.description ?? ""} ${plugin.marketplaceName}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  const sorted = [...matches].sort(
    (a, b) => (b.installCount ?? 0) - (a.installCount ?? 0) || a.name.localeCompare(b.name),
  );
  return { rows: sorted.slice(0, limit), total: matches.length };
}

/**
 * A command the CLI wants a person to approve before it runs, from a refused
 * install or update. Its fingerprint goes back as `--accept-command`, which
 * accepts exactly that command and nothing else.
 */
export function shownCommandOf(run: PluginRun): { text: string; sha256: string } | null {
  const shown = run.result?.shownCommand;
  if (typeof shown !== "object" || shown === null) return null;
  const record = shown as Record<string, unknown>;
  const sha256 = record.sha256;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256)) return null;
  const text =
    typeof record.command === "string"
      ? record.command
      : typeof record.text === "string"
        ? record.text
        : JSON.stringify(record, null, 2);
  return { text, sha256 };
}

/** One line for the panel's status bar: the CLI's own message when it gave one. */
export function runMessage(run: PluginRun): string {
  const message = run.result?.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  const lines = run.message.trim().split("\n");
  return lines[lines.length - 1] || (run.ok ? "done" : "failed");
}

/**
 * Whether a refused run asked for something that is already so, such as
 * disabling a disabled plugin. Not worth showing as a failure.
 */
export const alreadyDone = (run: PluginRun): boolean => run.result?.alreadyInGoalState === true;

/**
 * Plugins changed on disk. Every window's live sessions reload theirs, since a
 * running `claude` reads plugins once at start and again only on request.
 */
const PLUGINS_CHANGED = "mangouste://plugins-changed";

export const announcePluginsChanged = (): Promise<void> => emit(PLUGINS_CHANGED);

export const onPluginsChanged = (handler: () => void): Promise<UnlistenFn> =>
  listen(PLUGINS_CHANGED, () => handler());
