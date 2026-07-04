import { useAgents } from "../../app/useAgents";
import { updateSettings } from "../../app/settingsManager";
import { useSettings } from "../../app/useSettings";
import { selectableAgents } from "../../domain/agents";

/**
 * General preferences: the default agent ([F6]/[F1]). Fetches the catalog
 * itself (per mount, like WorkspaceForm) — opening settings re-detects a
 * just-installed agent instead of showing the boot-time picture.
 */
export function GeneralSection() {
  const defaultAgent = useSettings()?.defaultAgent;
  const { agents } = useAgents();
  const agentOptions = selectableAgents(agents);

  return (
    <>
      <span className="form__label">Default agent</span>
      <div className="form__types">
        {agentOptions.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`form__type${a.id === defaultAgent ? " form__type--active" : ""}`}
            onClick={() => updateSettings({ defaultAgent: a.id })}
          >
            {a.label}
          </button>
        ))}
      </div>
      <span className="settings__hint">
        Preselected when creating workspaces and agents
      </span>
    </>
  );
}
