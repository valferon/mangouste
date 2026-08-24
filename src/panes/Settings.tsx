import { applyTheme, type Theme } from "../lib/theme";

interface SettingsProps {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  permissionMode: string;
  onPermissionMode: (mode: string) => void;
  workspaceRoot: string;
  onWorkspaceRoot: (root: string) => void;
  onClose: () => void;
}

const THEMES: Theme[] = ["system", "light", "dark"];
const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];

export function Settings({
  theme,
  onTheme,
  permissionMode,
  onPermissionMode,
  workspaceRoot,
  onWorkspaceRoot,
  onClose,
}: SettingsProps) {
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
          <label>Theme</label>
          <div className="segmented">
            {THEMES.map((option) => (
              <button
                key={option}
                data-active={theme === option}
                onClick={() => {
                  applyTheme(option);
                  onTheme(option);
                }}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
        <p className="setting-hint">
          <code>system</code> follows your desktop preference live.
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
