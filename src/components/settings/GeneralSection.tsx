import { useAgents } from "../../app/useAgents";
import { updateSettings } from "../../app/settingsManager";
import { useSettings } from "../../app/useSettings";
import { selectableAgents } from "../../domain/agents";
import {
  SUSPENDED_AGENT_PLACEMENTS,
  DOCK_MODES,
  DEFAULT_SETTINGS,
  type SuspendedAgentPlacement,
  type DockMode,
} from "../../domain/settings";
import { McpServerRow } from "./McpServerRow";

/** Label + one-line explanation for each suspended-agent placement. */
const SUSPENDED_OPTIONS: Record<
  SuspendedAgentPlacement,
  { label: string; hint: string }
> = {
  pane: {
    label: "Keep pane",
    hint: "Suspended agents stay in the deck with their Resume card.",
  },
  tray: {
    label: "Tray",
    hint:
      "Suspending moves agents to the bottom tray; restoring one keeps it stopped.",
  },
};

/** Label + one-line explanation for each dock mode, in picker order. */
const DOCK_OPTIONS: Record<DockMode, { label: string; hint: string }> = {
  docked: {
    label: "Docked",
    hint: "The dock takes a column of its own — the agent grid shrinks to fit.",
  },
  floating: {
    label: "Floating",
    hint: "The dock lies over the deck — the agent grid keeps its full width.",
  },
};

/**
 * General preferences: the default agent ([F6]/[F1]), where a suspended
 * agent stays, how the dock occupies the window, and whether a restored deck
 * comes back running or stopped — then
 * the MCP server's row, which is not a preference but a fact about the
 * running transport ([`McpServerRow`]). Fetches the catalog itself (per
 * mount, like WorkspaceForm) — opening settings re-detects a just-installed
 * agent instead of showing the boot-time picture.
 */
export function GeneralSection() {
  const settings = useSettings();
  const defaultAgent = settings?.defaultAgent;
  const defaultYolo = settings?.defaultYolo ?? DEFAULT_SETTINGS.defaultYolo;
  const suspendedAgentPlacement =
    settings?.suspendedAgentPlacement ??
    DEFAULT_SETTINGS.suspendedAgentPlacement;
  const dockMode = settings?.dockMode ?? DEFAULT_SETTINGS.dockMode;
  const parkAgentsOnLaunch =
    settings?.parkAgentsOnLaunch ?? DEFAULT_SETTINGS.parkAgentsOnLaunch;
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

      <span className="form__label">YOLO mode</span>
      <div className="form__types">
        {[true, false].map((on) => (
          <button
            key={String(on)}
            type="button"
            className={`form__type${defaultYolo === on ? " form__type--active" : ""}`}
            onClick={() => updateSettings({ defaultYolo: on })}
          >
            {on ? "On" : "Off"}
          </button>
        ))}
      </div>
      <span className="settings__hint">
        New agents run without permission prompts — each creation dialog can
        still switch it per agent
      </span>

      <span className="form__label">Suspended agents</span>
      <div
        className="form__types"
        role="group"
        aria-label="Suspended agents"
      >
        {SUSPENDED_AGENT_PLACEMENTS.map((placement) => (
          <button
            key={placement}
            type="button"
            className={`form__type${placement === suspendedAgentPlacement ? " form__type--active" : ""}`}
            aria-label={`Suspended agents: ${SUSPENDED_OPTIONS[placement].label}`}
            aria-pressed={placement === suspendedAgentPlacement}
            onClick={() =>
              updateSettings({ suspendedAgentPlacement: placement })
            }
          >
            {SUSPENDED_OPTIONS[placement].label}
          </button>
        ))}
      </div>
      <span className="settings__hint">
        {SUSPENDED_OPTIONS[suspendedAgentPlacement].hint}
      </span>

      <span className="form__label">Dock</span>
      <div className="form__types">
        {DOCK_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className={`form__type${mode === dockMode ? " form__type--active" : ""}`}
            onClick={() => updateSettings({ dockMode: mode })}
          >
            {DOCK_OPTIONS[mode].label}
          </button>
        ))}
      </div>
      <span className="settings__hint">{DOCK_OPTIONS[dockMode].hint}</span>

      <span className="form__label">On launch</span>
      <div className="form__types">
        {[false, true].map((parked) => (
          <button
            key={String(parked)}
            type="button"
            className={`form__type${parkAgentsOnLaunch === parked ? " form__type--active" : ""}`}
            onClick={() => updateSettings({ parkAgentsOnLaunch: parked })}
          >
            {/* The word the pane's own card will use for what this produces.
                "Suspended" is reserved for a pane the USER stopped, which
                carries a timestamp this one has no equivalent of. */}
            {parked ? "Stopped" : "Running"}
          </button>
        ))}
      </div>
      <span className="settings__hint">
        {parkAgentsOnLaunch
          ? "Restored agents wait, stopped — resume each one from its pane"
          : "Restored agents resume their sessions right away"}
      </span>

      <McpServerRow />
    </>
  );
}
