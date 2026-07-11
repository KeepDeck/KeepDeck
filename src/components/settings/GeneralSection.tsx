import { useAgents } from "../../app/useAgents";
import { updateSettings } from "../../app/settingsManager";
import { useSettings } from "../../app/useSettings";
import { selectableAgents } from "../../domain/agents";
import {
  COLLAPSE_STYLES,
  DEFAULT_SETTINGS,
  type CollapseStyle,
} from "../../domain/settings";

/** Label + one-line explanation for each collapse style, in picker order. */
const COLLAPSE_OPTIONS: Record<CollapseStyle, { label: string; hint: string }> = {
  tray: {
    label: "Tray",
    hint: "Minimized agents dock as chips in a strip below the grid.",
  },
  strip: {
    label: "Strip",
    hint: "Minimized agents fold to their own header bar below the grid.",
  },
  list: {
    label: "List",
    hint: "The workspace becomes a list — one agent open at a time.",
  },
};

/**
 * General preferences: the default agent ([F6]/[F1]) and how a minimized agent
 * is presented in the deck. Fetches the catalog itself (per mount, like
 * WorkspaceForm) — opening settings re-detects a just-installed agent instead
 * of showing the boot-time picture.
 */
export function GeneralSection() {
  const settings = useSettings();
  const defaultAgent = settings?.defaultAgent;
  const collapseStyle = settings?.collapseStyle ?? DEFAULT_SETTINGS.collapseStyle;
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

      <span className="form__label">Minimized agents</span>
      <div className="form__types">
        {COLLAPSE_STYLES.map((style) => (
          <button
            key={style}
            type="button"
            className={`form__type${style === collapseStyle ? " form__type--active" : ""}`}
            onClick={() => updateSettings({ collapseStyle: style })}
          >
            {COLLAPSE_OPTIONS[style].label}
          </button>
        ))}
      </div>
      <span className="settings__hint">{COLLAPSE_OPTIONS[collapseStyle].hint}</span>
    </>
  );
}
