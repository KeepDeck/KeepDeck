import { useAgents } from "../../app/useAgents";
import { updateSettings } from "../../app/settingsManager";
import { useSettings } from "../../app/useSettings";
import { selectableAgents } from "../../domain/agents";
import {
  COLLAPSE_STYLES,
  DECK_LAYOUTS,
  DEFAULT_SETTINGS,
  type CollapseStyle,
  type DeckLayout,
} from "../../domain/settings";

/** Label + one-line explanation for each deck layout, in picker order. */
const LAYOUT_OPTIONS: Record<DeckLayout, { label: string; hint: string }> = {
  grid: {
    label: "Grid",
    hint: "Agents tile in a square grid; minimize ones you're not watching.",
  },
  list: {
    label: "List",
    hint: "Agents stack in a list — open one at a time; the rest fold to bars.",
  },
};

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
  none: {
    label: "None",
    hint: "Minimizing is off — every agent stays on the grid.",
  },
};

/**
 * General preferences: the default agent ([F6]/[F1]), the deck layout, and —
 * for the grid layout — how a minimized agent is presented. Fetches the catalog
 * itself (per mount, like WorkspaceForm) — opening settings re-detects a
 * just-installed agent instead of showing the boot-time picture.
 */
export function GeneralSection() {
  const settings = useSettings();
  const defaultAgent = settings?.defaultAgent;
  const deckLayout = settings?.deckLayout ?? DEFAULT_SETTINGS.deckLayout;
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

      <span className="form__label">Deck layout</span>
      <div className="form__types">
        {DECK_LAYOUTS.map((layout) => (
          <button
            key={layout}
            type="button"
            className={`form__type${layout === deckLayout ? " form__type--active" : ""}`}
            onClick={() => updateSettings({ deckLayout: layout })}
          >
            {LAYOUT_OPTIONS[layout].label}
          </button>
        ))}
      </div>
      <span className="settings__hint">{LAYOUT_OPTIONS[deckLayout].hint}</span>

      <span className="form__label">Minimized agents</span>
      <div className="form__types">
        {COLLAPSE_STYLES.map((style) => (
          <button
            key={style}
            type="button"
            className={`form__type${style === collapseStyle ? " form__type--active" : ""}`}
            disabled={deckLayout !== "grid"}
            onClick={() => updateSettings({ collapseStyle: style })}
          >
            {COLLAPSE_OPTIONS[style].label}
          </button>
        ))}
      </div>
      <span className="settings__hint">
        {deckLayout === "grid"
          ? COLLAPSE_OPTIONS[collapseStyle].hint
          : "Applies to the grid layout."}
      </span>
    </>
  );
}
