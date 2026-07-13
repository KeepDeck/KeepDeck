import { useEffect, useState } from "react";
import type {
  CustomSettingsFieldProps,
  VoiceModelInfo,
} from "@keepdeck/plugin-api";
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
  const { ctx } = runtime();
  const [models, setModels] = useState<VoiceModelInfo[] | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  // The pick lives in the plugin's persisted settings values — the same
  // on-disk bag as declarative fields, so it survives restarts.
  const active =
    typeof values[MODEL_KEY] === "string" ? (values[MODEL_KEY] as string) : DEFAULT_MODEL;

  const refresh = () =>
    ctx.services.voice
      .models()
      .then(setModels)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const download = (id: string) => {
    setProgress((p) => ({ ...p, [id]: 0 }));
    void ctx.services.voice
      .downloadModel(id, ({ received, total }) => {
        setProgress((p) => ({
          ...p,
          [id]: total ? Math.round((received / total) * 100) : 0,
        }));
      })
      .then(() => refresh())
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() =>
        setProgress((p) => {
          const { [id]: _done, ...rest } = p;
          return rest;
        }),
      );
  };

  const pick = (id: string) => write(MODEL_KEY, id);

  return (
    <div className="voice-models">
      {error && <div className="voice-models__error">{error}</div>}
      {models?.map((m) => {
        const meta = CARD_META[m.id];
        const isActive = active === m.id;
        const downloading = progress[m.id] !== undefined;
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
                      void ctx.services.voice.deleteModel(m.id).then(refresh);
                    }}
                  >
                    Delete
                  </button>
                ) : downloading ? (
                  <span className="voice-models__progress">{progress[m.id]}%</span>
                ) : (
                  <button
                    type="button"
                    className="voice-models__act"
                    onClick={(e) => {
                      e.stopPropagation();
                      download(m.id);
                    }}
                  >
                    Download
                  </button>
                )}
              </span>
            </div>
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
