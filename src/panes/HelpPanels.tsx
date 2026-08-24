import { useEffect, useState } from "react";
import { formatAppInfo, readAppInfo, type AppInfo } from "../lib/appInfo";
import { copyText } from "../lib/editing";
import { openExternal } from "../lib/ipc";
import { SHORTCUT_GROUPS } from "../lib/keybindings";

/** Where Help ▸ points. The only hand-written strings in the Help menu. */
export const REPO_URL = "https://github.com/valferon/mangouste";
export const ISSUES_URL = `${REPO_URL}/issues`;

/** Escape closes, for both sheets. Registered at the window, like the others. */
function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);
}

/**
 * Help ▸ About.
 *
 * Every fact is read at runtime — see `lib/appInfo.ts`. The Copy button exists
 * because the reason anyone opens this sheet is to paste it into an issue.
 */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [copied, setCopied] = useState(false);
  useEscape(onClose);

  useEffect(() => {
    let cancelled = false;
    void readAppInfo().then((next) => {
      if (!cancelled) setInfo(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div
      className="quickopen-scrim"
      onMouseDown={(event) => event.button === 0 && onClose()}
    >
      <div className="settings about" onMouseDown={(event) => event.stopPropagation()}>
        <div className="pane-header">
          <span>About</span>
          <div className="actions">
            <button className="toggle-button" onClick={onClose}>
              ×
            </button>
          </div>
        </div>

        {info === null ? (
          <div className="empty-note">Reading version…</div>
        ) : (
          <>
            <div className="about-head">
              <span className="about-name">{info.name}</span>
              <span className="about-version">{info.version}</span>
              {info.channel !== "release" && (
                <span className="about-channel">{info.channel}</span>
              )}
            </div>
            <p className="setting-hint about-blurb">
              Single-window, multi-repo Claude Code workbench.
            </p>
            <div className="fact-grid about-facts selectable">
              <span className="fact-key">version</span>
              <span className="fact-value">{info.version}</span>
              <span className="fact-key">commit</span>
              <span className="fact-value">{info.commit ?? "unknown"}</span>
              <span className="fact-key">built</span>
              <span className="fact-value">{info.built.replace("T", " ").slice(0, 19)}</span>
              <span className="fact-key">tauri</span>
              <span className="fact-value">{info.tauri}</span>
              <span className="fact-key">webview</span>
              <span className="fact-value">{info.webview}</span>
              <span className="fact-key">platform</span>
              <span className="fact-value">{info.platform}</span>
              <span className="fact-key">identifier</span>
              <span className="fact-value">{info.identifier}</span>
            </div>
            <div className="setting-row about-actions">
              <button
                className="toggle-button"
                onClick={() => {
                  void copyText(formatAppInfo(info));
                  setCopied(true);
                }}
              >
                {copied ? "copied" : "Copy version info"}
              </button>
              <button className="toggle-button" onClick={() => void openExternal(REPO_URL)}>
                Repository
              </button>
              <button className="toggle-button" onClick={() => void openExternal(ISSUES_URL)}>
                Report an issue
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Help ▸ Keyboard Shortcuts. Rendered straight off the `CHORD` table. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useEscape(onClose);
  return (
    <div
      className="quickopen-scrim"
      onMouseDown={(event) => event.button === 0 && onClose()}
    >
      <div className="settings shortcuts" onMouseDown={(event) => event.stopPropagation()}>
        <div className="pane-header">
          <span>Keyboard Shortcuts</span>
          <div className="actions">
            <button className="toggle-button" onClick={onClose}>
              ×
            </button>
          </div>
        </div>
        <div className="shortcuts-body">
          {SHORTCUT_GROUPS.map((group) => (
            <div className="shortcut-group" key={group.title}>
              <div className="shortcut-title">{group.title}</div>
              {group.rows.map((row) => (
                <div className="shortcut-row" key={`${group.title}:${row.keys}:${row.what}`}>
                  <span className="shortcut-keys">{row.keys}</span>
                  <span className="shortcut-what">{row.what}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
