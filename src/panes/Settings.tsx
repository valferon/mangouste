import { SYSTEM, themesOfKind, type Theme } from "../lib/theme";

interface SettingsProps {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  permissionMode: string;
  onPermissionMode: (mode: string) => void;
  restoreTabs: boolean;
  onRestoreTabs: (on: boolean) => void;
  workspaceRoot: string;
  onWorkspaceRoot: (root: string) => void;
  onClose: () => void;
}

const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];

export function Settings({
  theme,
  onTheme,
  permissionMode,
  onPermissionMode,
  restoreTabs,
  onRestoreTabs,
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
          Replicas of the themes shipped with VS Code. <code>Follow desktop</code> tracks
          your desktop's light/dark preference live, painting Dark+ or Light+.
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
          Applied to newly started sessions. <code>default</code> stalls in this app:
          permission prompts are not answered yet.
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
