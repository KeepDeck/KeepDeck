import { downloadPercent } from "@keepdeck/plugin-api";
import type { DownloadsSnapshot } from "./downloads";
import { MODEL_CATALOG, type VoiceModelInfo } from "./modelCatalog";

/**
 * How models are shown — the cards in settings and the names in the Voice
 * tab — decided here, once. Components render these views; they decide
 * nothing.
 */

/** Display metadata the backend registry doesn't carry — tuning knobs for
 * the cards, keyed by model id. Ratings are relative within this list. */
const CARD_META: Record<
  string,
  { blurb: string; langs: string; accuracy: number; speed: number }
> = {
  "whisper-base-q5_1": {
    blurb: "Fastest, light on memory — good for short commands",
    langs: "≈100 languages",
    accuracy: 0.4,
    speed: 0.95,
  },
  "whisper-small-q5_1": {
    blurb: "Balanced accuracy and speed",
    langs: "≈100 languages",
    accuracy: 0.6,
    speed: 0.75,
  },
  "whisper-small": {
    blurb: "Balanced — good for short commands",
    langs: "≈100 languages",
    accuracy: 0.6,
    speed: 0.8,
  },
  "whisper-large-v3-turbo-q5_0": {
    blurb: "Best accuracy — dictation and long phrases",
    langs: "≈100 languages",
    accuracy: 0.9,
    speed: 0.5,
  },
  "parakeet-tdt-0.6b-v3": {
    blurb: "Fast and accurate — punctuation built in",
    langs: "25 languages",
    accuracy: 0.95,
    speed: 0.9,
  },
};

/** A model's display name: its catalog label without the em-dash tail —
 * the ONE naming of a model (the tab and the cards used to name Parakeet
 * differently). Unknown ids show as themselves. */
export function modelName(id: string): string {
  const label = MODEL_CATALOG.find((m) => m.id === id)?.label;
  return label ? label.split(" — ")[0] : id;
}

/** What a card's action slot offers. */
export type CardAction =
  | { kind: "delete" }
  | { kind: "cancel"; progress: string }
  | { kind: "download"; label: "Download" | "Retry" }
  | { kind: "none" };

export interface ModelCard {
  id: string;
  name: string;
  blurb: string;
  langs: string;
  accuracy: number;
  speed: number;
  size: string;
  /** This model transcribes now. */
  active: boolean;
  /** Installed, so choosing the card makes it active. */
  selectable: boolean;
  legacy: boolean;
  action: CardAction;
  /** The download bar while downloading: a known percent, or indeterminate. */
  bar: { percent: number | null } | null;
  /** The last download or removal failure for this model. */
  error: string | null;
}

/** One card per model worth showing: a retired model with nothing installed
 * has nothing to offer and is hidden; a retired install keeps working and is
 * marked Legacy. */
export function modelCards(
  models: readonly VoiceModelInfo[],
  activeId: string | null,
  dl: DownloadsSnapshot,
  removeErrors: Readonly<Record<string, string>>,
): ModelCard[] {
  return models
    .filter((m) => m.installed || !m.retired)
    .map((m) => {
      const meta = CARD_META[m.id];
      const state = dl.active[m.id];
      const percent = state ? downloadPercent(state) : null;
      const downloadError = dl.errors[m.id] ?? null;
      const action: CardAction = m.installed
        ? { kind: "delete" }
        : state
          ? { kind: "cancel", progress: percent === null ? "…" : `${percent}%` }
          : m.retired
            ? { kind: "none" }
            : { kind: "download", label: downloadError ? "Retry" : "Download" };
      return {
        id: m.id,
        name: modelName(m.id),
        blurb: meta?.blurb ?? "",
        langs: meta?.langs ?? "",
        accuracy: meta?.accuracy ?? 0.5,
        speed: meta?.speed ?? 0.5,
        size: `${m.sizeMb} MB`,
        active: m.installed && m.id === activeId,
        selectable: m.installed,
        legacy: m.retired,
        action,
        bar: state ? { percent } : null,
        error: removeErrors[m.id] ?? downloadError,
      };
    });
}
