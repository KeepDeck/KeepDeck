import type { PluginCrash } from "../../app/pluginHealth";
import { restartPlugin } from "../../app/pluginManager";
import { writeText } from "../../ipc/clipboard";

/**
 * What a crashed plugin's UI area shows instead of its (dead) content: the
 * plain fact, the crash log — visible and copyable, so a report can carry
 * it — and the one recovery action, Restart (which reloads the plugin,
 * remounts fresh boundaries and clears the crash store). Host chrome, not
 * plugin code: this panel must work precisely when the plugin doesn't.
 */
export function PluginFailurePanel({
  pluginId,
  label,
  crashes,
}: {
  pluginId: string;
  label: string;
  crashes: readonly PluginCrash[];
}) {
  const log = crashes
    .map((crash) => `[${crash.surface}] ${crash.detail}`)
    .join("\n\n");
  return (
    <div className="plugin-failure" role="alert">
      <p className="plugin-failure__title">{label} isn't working</p>
      <p className="plugin-failure__hint">
        Part of this plugin crashed ({crashes[crashes.length - 1]?.surface}).
        Restarting it usually recovers.
      </p>
      <pre className="plugin-failure__log">{log}</pre>
      <div className="plugin-failure__actions">
        <button
          type="button"
          className="form__cancel"
          onClick={() => void writeText(log)}
        >
          Copy log
        </button>
        <button
          type="button"
          className="form__create"
          onClick={() => void restartPlugin(pluginId)}
        >
          Restart plugin
        </button>
      </div>
    </div>
  );
}
