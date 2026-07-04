import { updateSettings } from "../../app/settingsManager";
import { useSettings } from "../../app/useSettings";

/**
 * Experimental features, each an explicit opt-in. A flag gates only its
 * feature's UI entry points: turning one off never touches what the feature
 * already created (panes keep running, stored config stays).
 */
export function ExperimentsSection() {
  const enabled = useSettings()?.experimentRunPresets ?? false;

  return (
    <>
      <label className="settings__toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) =>
            updateSettings({ experimentRunPresets: e.target.checked })
          }
          aria-label="Enable run presets"
        />
        <span className="settings__toggle-text">
          Run presets
          <span className="settings__hint">
            Launch the app you're building in a pane: per-workspace run
            commands (▶ in a pane header), a one-time worktree setup command,
            and KEEPDECK_WORKTREE / KEEPDECK_BRANCH / KEEPDECK_PORT in the
            command's environment. May change or disappear.
          </span>
        </span>
      </label>
    </>
  );
}
