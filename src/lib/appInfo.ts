/**
 * What "which version am I running" resolves to.
 *
 * Nothing here is typed by hand. The product name and version come from Tauri,
 * which reads them out of `tauri.conf.json` at build time, so cutting a release
 * updates the About sheet by itself; the commit and build stamp are injected by
 * Vite (see `vite.config.ts`). A version string maintained in the frontend would
 * be a second source of truth, and the one that goes stale.
 */

import { getIdentifier, getName, getTauriVersion, getVersion } from "@tauri-apps/api/app";

export interface AppInfo {
  name: string;
  version: string;
  identifier: string;
  tauri: string;
  /** Short commit the bundle was built from, or `null` outside a git checkout. */
  commit: string | null;
  /** ISO build stamp. In dev this is when the dev server started. */
  built: string;
  /** `dev` when served by Vite, `release` from a bundle. */
  channel: string;
  /** Rendering engine, as far as the webview will admit to one. */
  webview: string;
  platform: string;
}

/** The engine and its version, out of a user-agent string that names several. */
export function webviewLabel(userAgent: string): string {
  const webkit = /AppleWebKit\/([\d.]+)/.exec(userAgent);
  if (webkit) return `WebKit ${webkit[1]}`;
  const chrome = /Chrome\/([\d.]+)/.exec(userAgent);
  if (chrome) return `Chromium ${chrome[1]}`;
  return "unknown";
}

/**
 * The OS, from the one part of the user-agent that still carries it.
 *
 * `fallback` is passed in rather than read from `navigator` here, so this stays a
 * pure string function its test can call without a browser standing behind it.
 */
export function platformLabel(userAgent: string, fallback: string): string {
  const parenthetical = /\(([^)]+)\)/.exec(userAgent);
  return parenthetical?.[1] ?? fallback;
}

/**
 * Read every fact at once.
 *
 * The Tauri calls are IPC, so this is async and the About sheet renders a
 * placeholder for one frame. Each one falls back rather than rejecting: a
 * missing capability must not leave the sheet blank, since the version is
 * exactly what someone filing a bug came here for.
 */
export async function readAppInfo(): Promise<AppInfo> {
  const [name, version, identifier, tauri] = await Promise.all([
    getName().catch(() => "mangouste"),
    getVersion().catch(() => "unknown"),
    getIdentifier().catch(() => "unknown"),
    getTauriVersion().catch(() => "unknown"),
  ]);
  const userAgent = navigator.userAgent;
  return {
    name,
    version,
    identifier,
    tauri,
    commit: __BUILD_COMMIT__ || null,
    built: __BUILD_DATE__,
    channel: import.meta.env.DEV ? "dev" : "release",
    webview: webviewLabel(userAgent),
    platform: platformLabel(userAgent, navigator.platform || "unknown"),
  };
}

/** The sheet's facts as pasteable lines, for dropping into a bug report. */
export function formatAppInfo(info: AppInfo): string {
  return [
    `${info.name} ${info.version} (${info.channel})`,
    `commit: ${info.commit ?? "unknown"}`,
    `built: ${info.built}`,
    `tauri: ${info.tauri}`,
    `webview: ${info.webview}`,
    `platform: ${info.platform}`,
    `identifier: ${info.identifier}`,
  ].join("\n");
}
