import type { Capability } from "@keepdeck/plugin-api";
import {
  externalPluginInfo,
  pluginHost,
  rescanPlugins,
  restartPlugin,
} from "../../app/pluginManager";
import { useInstalledPlugins } from "../../plugins";

/**
 * The installed plugins — not an experiment, a first-class part of the app
 * (user decision: the system either exists or it doesn't; no master flag).
 * Each plugin shows its enable toggle and, for an external one, the access it
 * asks for (enabling IS the consent) plus a `dev` badge when it's an unpacked
 * folder. Rescan re-reads the plugins folder (KeepDeck doesn't watch it);
 * Restart reloads an active plugin.
 */
export function PluginsSection() {
  const installed = useInstalledPlugins(pluginHost);

  return (
    <>
      <div className="settings__plugins-bar">
        <button
          type="button"
          className="form__create"
          onClick={() => void rescanPlugins()}
        >
          Rescan
        </button>
        <span className="settings__hint">
          Plugins live in <code>~/.config/keepdeck/plugins</code>.
        </span>
      </div>

      {installed.length === 0 ? (
        <p className="settings__hint">No plugins installed.</p>
      ) : (
        <div className="settings__plugins">
          {installed.map((plugin) => {
            const external = externalPluginInfo(plugin.manifest.id);
            return (
              <div key={plugin.manifest.id} className="settings__plugin">
                <label className="settings__toggle">
                  <input
                    type="checkbox"
                    checked={plugin.status.kind !== "disabled"}
                    onChange={(e) =>
                      void pluginHost.setEnabled(
                        plugin.manifest.id,
                        e.target.checked,
                      )
                    }
                    aria-label={`Enable plugin ${plugin.manifest.name}`}
                  />
                  <span className="settings__toggle-text">
                    <span className="settings__plugin-name">
                      {plugin.manifest.name}
                      {external?.dev && (
                        <span className="settings__badge">dev</span>
                      )}
                    </span>
                    <span className="settings__hint">
                      {plugin.manifest.id} · {plugin.manifest.version}
                      {plugin.status.kind === "failed" &&
                        ` · failed: ${plugin.status.reason}`}
                    </span>
                    {external && plugin.manifest.capabilities.length > 0 && (
                      <span className="settings__hint">
                        Wants: {plugin.manifest.capabilities.map(describe).join(", ")}
                      </span>
                    )}
                  </span>
                </label>
                {plugin.status.kind === "active" && (
                  <button
                    type="button"
                    className="form__cancel settings__plugin-restart"
                    onClick={() => void restartPlugin(plugin.manifest.id)}
                    title={`Restart ${plugin.manifest.name}`}
                  >
                    Restart
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/** A capability in plain words — what the user is consenting to. */
function describe(cap: Capability): string {
  switch (cap.kind) {
    case "exec":
      return `run ${cap.commands.join("/")}`;
    case "fs":
      return cap.scope === "everywhere" ? "read any file" : "read project files";
    case "net":
      return `reach ${cap.domains.join("/")}`;
    case "ports":
      return "allocate ports";
    case "open":
      return "open links & files";
  }
}
