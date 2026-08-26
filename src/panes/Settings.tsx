import type { SessionSurface } from "../lib/sessionSurface";
import { SYSTEM, themesOfKind, type Theme } from "../lib/theme";

interface SettingsProps {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  sessionSurface: SessionSurface;
  onSessionSurface: (surface: SessionSurface) => void;
  permissionMode: string;
  onPermissionMode: (mode: string) => void;
  restoreTabs: boolean;
  onRestoreTabs: (on: boolean) => void;
  upstreamWatch: boolean;
  onUpstreamWatch: (on: boolean) => void;
  workspaceRoot: string;
  onWorkspaceRoot: (root: string) => void;
  onClose: () => void;
}

const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];

export function Settings({
  theme,
  onTheme,
  sessionSurface,
  onSessionSurface,
  permissionMode,
  onPermissionMode,
  restoreTabs,
  onRestoreTabs,
  upstreamWatch,
  onUpstreamWatch,
  workspaceRoot,
  onWorkspaceRoot,
  onClose,
}: SettingsProps) {
  // Stamping is the App's job: it already applies `theme` in an effect, so
  // painting here too would write the preference twice per change.
  const setTheme = onTheme;

  return (
    <div
      className="quickopen-scrim"
      onMouseDown={(event) => event.button === 0 && onClose()}
    >
      <div className="settings" onMouseDown={(event) => event.stopPropagation()}>
        <div className="pane-header">
          <span>Settings</span>
          <div className="actions">
            <button className="toggle-button" onClick={onClose}>
              ×
            </button>
          </div>
        </div>

        <div className="setting-row">
          <label>Color theme</label>
          <select value={theme} onChange={(event) => setTheme(event.target.value)}>
            <option value={SYSTEM}>Follow desktop</option>
            <optgroup label="Dark">
              {themesOfKind("dark").map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Light">
              {themesOfKind("light").map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        <p className="setting-hint">
          Replicas of the themes shipped with VS Code, plus Monokai++ and One Monokai from
          their extensions. <code>Follow desktop</code> tracks your desktop's light/dark
          preference live, painting Dark+ or Light+.
        </p>

        <div className="setting-row">
          <label>Sessions run in</label>
          <div className="segmented">
            <button
              data-active={sessionSurface === "chat"}
              onClick={() => onSessionSurface("chat")}
            >
              app chat
            </button>
            <button
              data-active={sessionSurface === "terminal"}
              onClick={() => onSessionSurface("terminal")}
            >
              terminal
            </button>
          </div>
        </div>
        <p className="setting-hint">
          <code>terminal</code> puts <code>claude</code> itself in the session tab,
          in place of the chat pane — its own prompts, <code>/</code> commands,
          statusline and config, in a real shell. Same strip, same tabs; the
          terminal panel at the bottom is untouched and stays for shells. Applies
          to the next session opened, not to tabs already up. The Sessions rail
          watches both: it reads the transcripts on disk and does not care which
          one wrote them.
        </p>

        <div className="setting-row">
          <label>Default permission mode</label>
          <select value={permissionMode} onChange={(e) => onPermissionMode(e.target.value)}>
            {PERMISSION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </div>
        <p className="setting-hint">
          Applied to newly started sessions in the chat pane. <code>default</code> stalls
          in this app: permission prompts are not answered yet. Sessions run in the
          terminal are left alone — nothing here is passed to <code>claude</code> there.
        </p>

        <div className="setting-row">
          <label>Restore sessions on startup</label>
          <div className="segmented">
            <button data-active={restoreTabs} onClick={() => onRestoreTabs(true)}>
              on
            </button>
            <button data-active={!restoreTabs} onClick={() => onRestoreTabs(false)}>
              off
            </button>
          </div>
        </div>
        <p className="setting-hint">
          Restored sessions come back as tabs, but a tab does not start its{" "}
          <code>claude</code> process or read its transcript until you open it.
        </p>

        <div className="setting-row">
          <label>Check for upstream changes</label>
          <div className="segmented">
            <button data-active={upstreamWatch} onClick={() => onUpstreamWatch(true)}>
              on
            </button>
            <button data-active={!upstreamWatch} onClick={() => onUpstreamWatch(false)}>
              off
            </button>
          </div>
        </div>
        <p className="setting-hint">
          Runs <code>git fetch --all --prune</code> when a repo is opened and every five
          minutes after, so the branch chip in the status bar knows what is waiting
          upstream. Opening a repo with commits waiting offers to pull them, once per set
          of commits; the later checks light the <code>pull</code> button instead of
          interrupting. Fetching only writes remote-tracking refs — your branches and
          worktree are untouched. Off keeps the chip and its counts, which then move only
          when you fetch yourself.
        </p>

        <div className="setting-row">
          <label>Workspace root</label>
          <input
            value={workspaceRoot}
            onChange={(e) => onWorkspaceRoot(e.target.value)}
            spellCheck={false}
          />
        </div>
        <p className="setting-hint">Scanned for git repos to offer in Ctrl+P.</p>
      </div>
    </div>
  );
}
