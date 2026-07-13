import { useSyncExternalStore } from "react";
import type { CustomSettingsFieldProps } from "@keepdeck/plugin-api";
import { DEFAULT_MODEL, MODEL_KEY } from "../controller";
import { runtime } from "../runtime";

/**
 * The model manager, rendered inside the plugin's settings page (a `custom`
 * settings field — the declarative vocabulary has no download progress).
 * One card per registry model: what it's good at, languages, size, an
 * accuracy/speed read, and the install/active state. Clicking an installed
 * card makes it the active model; weights download on demand and never ship
 * with the app.
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

export function ModelsSection({ values, write }: CustomSettingsFieldProps) {
  const { ctx, downloads, models: store } = runtime();
  // Both the list and download progress come from plugin-level stores, so
  // this section, the dock tab, and a download in flight all see one truth.
  const models = useSyncExternalStore(store.subscribe, store.snapshot);
  const listError = useSyncExternalStore(store.subscribe, store.error);
  const dl = useSyncExternalStore(downloads.subscribe, downloads.snapshot);
  // The pick lives in the plugin's persisted settings values — the same
  // on-disk bag as declarative fields, so it survives restarts.
  const active =
    typeof values[MODEL_KEY] === "string" ? (values[MODEL_KEY] as string) : DEFAULT_MODEL;

  const download = (id: string) => void downloads.start(id);
  const cancel = (id: string) => downloads.cancel(id);
  const pick = (id: string) => write(MODEL_KEY, id);

  return (
    <div className="voice-models">
      <div className="voice-models__warn">
        Extremely experimental — recognition and commands are rough, and this
        may change or break between versions.
      </div>
      {listError && <div className="voice-models__error">{listError}</div>}
      {models?.map((m) => {
        // Retired = the source is gone: an install keeps working (and shows
        // a Legacy badge), an absent one has nothing to offer — hide it.
        if (m.retired && !m.installed) return null;
        const meta = CARD_META[m.id];
        const isActive = active === m.id;
        const state = dl.active[m.id];
        const downloading = state !== undefined;
        const error = dl.errors[m.id];
        return (
          <div
            key={m.id}
            className={`voice-models__card${isActive && m.installed ? " voice-models__card--active" : ""}`}
            onClick={() => m.installed && pick(m.id)}
            role="radio"
            aria-checked={isActive && m.installed}
          >
            <div className="voice-models__head">
              <span className="voice-models__name">
                {shortName(m.label)}
                {isActive && m.installed && (
                  <span className="voice-models__badge">✓ Active</span>
                )}
                {m.retired && (
                  <span className="voice-models__badge voice-models__badge--legacy">
                    Legacy
                  </span>
                )}
              </span>
              <Rating label="accuracy" value={meta?.accuracy ?? 0.5} />
            </div>
            <div className="voice-models__row">
              <span className="voice-models__blurb">{meta?.blurb ?? ""}</span>
              <Rating label="speed" value={meta?.speed ?? 0.5} />
            </div>
            <div className="voice-models__foot">
              <span>{meta?.langs ?? ""}</span>
              <span className="voice-models__foot-right">
                <span>{m.sizeMb} MB</span>
                {m.installed ? (
                  <button
                    type="button"
                    className="voice-models__act voice-models__act--delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      void ctx.services.voice
                        .deleteModel(m.id)
                        .then(() => store.refresh());
                    }}
                  >
                    Delete
                  </button>
                ) : downloading ? (
                  <>
                    <span className="voice-models__progress">
                      {state.percent === null ? "…" : `${state.percent}%`}
                    </span>
                    <button
                      type="button"
                      className="voice-models__act voice-models__act--delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        cancel(m.id);
                      }}
                      title="Stop — the next Download resumes from here"
                    >
                      ✕
                    </button>
                  </>
                ) : m.retired ? null : (
                  <button
                    type="button"
                    className="voice-models__act"
                    onClick={(e) => {
                      e.stopPropagation();
                      download(m.id);
                    }}
                  >
                    {error ? "Retry" : "Download"}
                  </button>
                )}
              </span>
            </div>
            {downloading && (
              <span className="voice-models__bar">
                <span
                  className="voice-models__bar-fill"
                  style={
                    state.percent === null
                      ? { width: "100%", opacity: 0.4 }
                      : { width: `${state.percent}%` }
                  }
                />
              </span>
            )}
            {error && <div className="voice-models__card-error">{error}</div>}
          </div>
        );
      })}
    </div>
  );
}

/** Card titles read better without the backend label's em-dash tail. */
function shortName(label: string): string {
  return label.split(" — ")[0];
}

function Rating({ label, value }: { label: string; value: number }) {
  return (
    <span className="voice-models__rating">
      <span className="voice-models__rating-label">{label}</span>
      <span className="voice-models__rating-track">
        <span
          className="voice-models__rating-fill"
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      </span>
    </span>
  );
}
