import { useAgents } from "../../app/useAgents";
import { updateSettings } from "../../app/settingsManager";
import { useSettings } from "../../app/useSettings";
import { selectableAgents } from "../../domain/agents";
import {
  MINIMIZE_STYLES,
  DECK_LAYOUTS,
  DEFAULT_SETTINGS,
  type MinimizeStyle,
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

/** Label + one-line explanation for each minimize style, in picker order. */
const MINIMIZE_OPTIONS: Record<MinimizeStyle, { label: string; hint: string }> = {
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
  const defaultYolo = settings?.defaultYolo ?? DEFAULT_SETTINGS.defaultYolo;
  const deckLayout = settings?.deckLayout ?? DEFAULT_SETTINGS.deckLayout;
  const minimizeStyle = settings?.minimizeStyle ?? DEFAULT_SETTINGS.minimizeStyle;
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
        {MINIMIZE_STYLES.map((style) => (
          <button
            key={style}
            type="button"
            className={`form__type${style === minimizeStyle ? " form__type--active" : ""}`}
            disabled={deckLayout !== "grid"}
            onClick={() => updateSettings({ minimizeStyle: style })}
          >
            {MINIMIZE_OPTIONS[style].label}
          </button>
        ))}
      </div>
      <span className="settings__hint">
        {deckLayout === "grid"
          ? MINIMIZE_OPTIONS[minimizeStyle].hint
          : "Applies to the grid layout."}
      </span>
    </>
  );
}
