import { updateSettings } from "../../app/settingsManager";
import { useSettings } from "../../app/useSettings";
import { DEFAULT_SETTINGS } from "../../domain/settings";

/**
 * Experimental features ([F6] → Experimental) — opt-in capabilities that ship
 * behind a setting because they aren't done. Each row mirrors the General
 * section's toggle pattern (label + On/Off + hint) so the sizing, spacing and
 * typography match every other section. The setting gates the CREATION
 * surface (the "+ Agent" dialog): turning it off hides the option going
 * forward — existing remote panes are NOT retroactively stopped, they keep
 * their endpoint until closed. The choice persists across restarts like every
 * other setting.
 */
export function ExperimentalSection() {
  const settings = useSettings();
  const remoteAgents =
    settings?.remoteAgents ?? DEFAULT_SETTINGS.remoteAgents;

  return (
    <>
      <span className="form__label">Remote agents</span>
      <div className="form__types">
        {[true, false].map((on) => (
          <button
            key={String(on)}
            type="button"
            className={`form__type${remoteAgents === on ? " form__type--active" : ""}`}
            onClick={() => updateSettings({ remoteAgents: on })}
          >
            {on ? "On" : "Off"}
          </button>
        ))}
      </div>
      <span className="settings__hint">
        Lets an agent that speaks a client/server protocol (Codex, OpenCode)
        run against a remote endpoint from the “+ Agent” dialog’s Where option.
        Off by default — the feature is experimental.
      </span>
    </>
  );
}
