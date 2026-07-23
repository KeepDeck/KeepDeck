import { updateSettings } from "../../app/settingsManager";
import { useSettings } from "../../app/useSettings";
import { DEFAULT_SETTINGS } from "../../domain/settings";

/**
 * Experimental features ([F6] → Experimental) — opt-in capabilities that ship
 * behind a setting because they aren't done. Each row is independent: turning
 * one off hides its surface everywhere (no half-state), and the choice
 * persists across restarts like every other setting.
 */
export function ExperimentalSection() {
  const settings = useSettings();
  const remoteAgents =
    settings?.remoteAgents ?? DEFAULT_SETTINGS.remoteAgents;

  return (
    <>
      <span className="form__label">Remote agents</span>
      <label className="settings__check">
        <input
          type="checkbox"
          checked={remoteAgents}
          onChange={(e) => updateSettings({ remoteAgents: e.target.checked })}
        />
        <span>Allow connecting agents to a remote server</span>
      </label>
      <span className="settings__hint">
        Lets an agent that speaks a client/server protocol (Codex, OpenCode)
        run against a remote endpoint from the “+ Agent” dialog’s Where option.
        Off by default — the feature is experimental.
      </span>
    </>
  );
}
