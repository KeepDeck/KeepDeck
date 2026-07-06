import { pluginHost } from "../../app/pluginManager";
import { useInstalledPlugins } from "../../plugins";

/**
 * The installed plugins — not an experiment, a first-class part of the app
 * (user decision: the system either exists or it doesn't; no master flag).
 * Each plugin gets its own enable toggle plus the one thing a broken plugin
 * owes the user: its failure reason.
 */
export function PluginsSection() {
  const installed = useInstalledPlugins(pluginHost);

  if (installed.length === 0) {
    return <p className="settings__hint">No plugins installed.</p>;
  }

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
