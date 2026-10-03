import { updateSettings } from "../../app/settingsManager";
import { useSettings } from "../../app/useSettings";
import { DEFAULT_SETTINGS } from "../../domain/settings";
import { Segmented } from "@keepdeck/ui-kit/Segmented";
import { ON_OFF } from "../../presentation/choices";

/**
 * Experimental features ([F6] → Experimental) — opt-in capabilities that ship
 * behind a setting because they aren't done. Each row mirrors the General
 * section's toggle pattern (label + On/Off + hint) so the sizing, spacing and
 * typography match every other section, and each choice persists across
 * restarts like every other setting.
 *
 * Remote agents gates the CREATION surface (the agent dialog) only, so
 * turning it off hides the option going forward while existing remote panes
 * keep their endpoint until closed.
 */
export function ExperimentalSection() {
  const settings = useSettings();
  const remoteAgents =
    settings?.remoteAgents ?? DEFAULT_SETTINGS.remoteAgents;

  return (
    <>
      <span className="form__label">Remote agents</span>
      <Segmented
        ariaLabel="Remote agents"
        options={ON_OFF}
        value={remoteAgents}
        onChange={(on) => updateSettings({ remoteAgents: on })}
      />
      <span className="settings__hint">
        Lets an agent that speaks a client/server protocol (Codex, OpenCode)
        run against a remote endpoint from the “Add member” dialog’s Where option.
        Off by default — the feature is experimental.
      </span>
    </>
  );
}
