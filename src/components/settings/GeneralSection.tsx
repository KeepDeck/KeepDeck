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
import { ArtifactsRows } from "./ArtifactsRows";
import { McpServerRow } from "./McpServerRow";
import { TasksRows } from "./TasksRows";
import { Segmented } from "@keepdeck/ui-kit/Segmented";
import { ON_OFF } from "../../presentation/choices";

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
 * agent stays, how the dock occupies the window, whether a restored deck
 * comes back running or stopped, fleet artifacts ([`ArtifactsRows`]) and
 * the task board ([`TasksRows`]) —
 * then the MCP server's row, which is not a preference but a fact about the
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
      <Segmented
        ariaLabel="Default agent"
        options={agentOptions.map((a) => ({ value: a.id, label: a.label }))}
        value={defaultAgent}
        onChange={(id) => updateSettings({ defaultAgent: id })}
      />
      <span className="settings__hint">
        Preselected when creating workspaces and agents
      </span>

      <span className="form__label">YOLO mode</span>
      <Segmented
        ariaLabel="YOLO mode"
        options={ON_OFF}
        value={defaultYolo}
        onChange={(on) => updateSettings({ defaultYolo: on })}
      />
      <span className="settings__hint">
        New agents run without permission prompts — each creation dialog can
        still switch it per agent
      </span>

      <span className="form__label">Suspended agents</span>
      <Segmented
        ariaLabel="Suspended agents"
        options={SUSPENDED_AGENT_PLACEMENTS.map((placement) => ({
          value: placement,
          label: SUSPENDED_OPTIONS[placement].label,
          ariaLabel: `Suspended agents: ${SUSPENDED_OPTIONS[placement].label}`,
        }))}
        value={suspendedAgentPlacement}
        onChange={(placement) => updateSettings({ suspendedAgentPlacement: placement })}
      />
      <span className="settings__hint">
        {SUSPENDED_OPTIONS[suspendedAgentPlacement].hint}
      </span>

      <span className="form__label">Dock</span>
      <Segmented
        ariaLabel="Dock"
        options={DOCK_MODES.map((mode) => ({ value: mode, label: DOCK_OPTIONS[mode].label }))}
        value={dockMode}
        onChange={(mode) => updateSettings({ dockMode: mode })}
      />
      <span className="settings__hint">{DOCK_OPTIONS[dockMode].hint}</span>

      <span className="form__label">On launch</span>
      {/* The words the pane's own card will use for what this produces.
          "Suspended" is reserved for a pane the USER stopped, which carries
          a timestamp this one has no equivalent of. */}
      <Segmented
        ariaLabel="On launch"
        options={[
          { value: false, label: "Running" },
          { value: true, label: "Stopped" },
        ]}
        value={parkAgentsOnLaunch}
        onChange={(parked) => updateSettings({ parkAgentsOnLaunch: parked })}
      />
      <span className="settings__hint">
        {parkAgentsOnLaunch
          ? "Restored agents wait, stopped — resume each one from its pane"
          : "Restored agents resume their sessions right away"}
      </span>

      <ArtifactsRows />
      <TasksRows />
      <McpServerRow />
    </>
  );
}
