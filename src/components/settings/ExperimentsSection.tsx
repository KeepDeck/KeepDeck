import { pluginHost } from "../../app/pluginManager";
import { updateSettings } from "../../app/settingsManager";
import { useSettings } from "../../app/useSettings";
import { useInstalledPlugins } from "../../plugins";

/**
 * Experimental features, each an explicit opt-in. A flag gates only its
 * feature's UI entry points: turning one off never touches what the feature
 * already created (panes keep running, stored config stays).
 */
export function ExperimentsSection() {
  const settings = useSettings();
  const runOn = settings?.experimentRunPresets ?? false;
  const pluginsOn = settings?.experimentPlugins ?? false;

  return (
    <>
      <label className="settings__toggle">
        <input
          type="checkbox"
          checked={runOn}
          onChange={(e) =>
            updateSettings({ experimentRunPresets: e.target.checked })
          }
          aria-label="Enable run presets"
        />
        <span className="settings__toggle-text">
          Run presets
          <span className="settings__hint">
            Launch the app you're building from the Run panel: per-workspace
            run commands, a one-time worktree setup command, and
            KEEPDECK_WORKTREE / KEEPDECK_BRANCH / KEEPDECK_PORT in the
            command's environment. May change or disappear.
          </span>
        </span>
      </label>
      <label className="settings__toggle">
        <input
          type="checkbox"
          checked={pluginsOn}
          onChange={(e) =>
            updateSettings({ experimentPlugins: e.target.checked })
          }
          aria-label="Enable plugins"
        />
        <span className="settings__toggle-text">
          Plugins
          <span className="settings__hint">
            Built-in plugins contribute dock tabs, top-bar actions and their
            own settings pages. The flag gates the surfaces, not the plugins
            themselves. May change or disappear.
          </span>
        </span>
      </label>
      {pluginsOn && <InstalledPlugins />}
    </>
  );
}

/** The installed-plugins list: per-plugin enable toggles plus the one thing
 * a broken plugin owes the user — its failure reason. */
function InstalledPlugins() {
  const installed = useInstalledPlugins(pluginHost);
  if (installed.length === 0) return null;

  return (
    <div className="settings__plugins">
      {installed.map((plugin) => (
        <label key={plugin.manifest.id} className="settings__toggle">
          <input
            type="checkbox"
            checked={plugin.status.kind !== "disabled"}
            onChange={(e) =>
              void pluginHost.setEnabled(plugin.manifest.id, e.target.checked)
            }
            aria-label={`Enable plugin ${plugin.manifest.name}`}
          />
          <span className="settings__toggle-text">
            {plugin.manifest.name}
            <span className="settings__hint">
              {plugin.manifest.id} · {plugin.manifest.version}
              {plugin.status.kind === "failed" &&
                ` · failed: ${plugin.status.reason}`}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}
