import { useSettings, useSettingsWrite } from "../../app/useSettings";
import { DEFAULT_SETTINGS } from "../../domain/settings";
import { Segmented } from "@keepdeck/ui-kit/Segmented";
import { ON_OFF } from "../../presentation/choices";
import { remoteAgentsHint } from "../../presentation/agentReachView";
import { useAgents } from "../../app/useAgents";

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
  const updateSettings = useSettingsWrite();
  const remoteAgents =
    settings?.remoteAgents ?? DEFAULT_SETTINGS.remoteAgents;
  const { agents } = useAgents();

  return (
    <>
      <span className="form__label">Remote agents</span>
      <Segmented
        ariaLabel="Remote agents"
        options={ON_OFF}
        value={remoteAgents}
        onChange={(on) => updateSettings({ remoteAgents: on })}
      />
      <span className="settings__hint">{remoteAgentsHint(agents)}</span>
    </>
  );
}
