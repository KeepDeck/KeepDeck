import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { VoiceModelInfo } from "@keepdeck/plugin-api";
import { DEFAULT_MODEL, MODEL_KEY } from "../controller";
import { runtime } from "../runtime";

/**
 * The Voice dock tab: the chat-log of what was heard and what was done, the
 * mic toggle for command mode, and the model manager (download-on-demand —
 * weights are never bundled, the picker IS the install surface).
 */
export function VoiceTab() {
  const { controller } = runtime();
  const snap = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [snap.history.length]);

  const listening = snap.phase === "listening";
  return (
    <div className="voice">
      <div className="voice__bar">
        <button
          type="button"
          className={`voice__mic${listening ? " voice__mic--on" : ""}`}
          onClick={() =>
            listening ? void controller.stop() : void controller.start("command")
          }
          disabled={snap.phase === "transcribing"}
          title="Toggle command listening (or hold ⌥Space)"
        >
          {listening ? "◼ Stop" : "🎙 Listen"}
        </button>
        {listening && <Meter level={snap.level} />}
        <span className="voice__spacer" />
        {snap.history.length > 0 && snap.phase === "idle" && (
          <button
            type="button"
            className="voice__model-btn"
            onClick={() => controller.clearHistory()}
            title="Clear the history"
          >
            Clear
          </button>
        )}
      </div>
      <div className="voice__status">
        {snap.phase === "idle" && "hold ⌥Space — speak a command · ⌥⇧Space — dictate into the focused agent · Esc cancels"}
        {snap.phase === "listening" &&
          `listening — release to ${snap.mode === "dictation" ? "send" : "run"}, Esc cancels`}
        {snap.phase === "transcribing" && "transcribing…"}
      </div>

      <div className="voice__log" ref={logRef}>
        {snap.history.length === 0 && (
          <div className="voice__empty">
            Try: “create an agent in KeepDeck with task run the tests” ·
            «перейди на Website» · hold ⌥⇧Space and dictate a prompt
          </div>
        )}
        {snap.history.map((entry) => (
          <div key={`${entry.at}-${entry.text}`} className={`voice__entry voice__entry--${entry.tone}`}>
            <span className="voice__tone">{TONE_GLYPH[entry.tone]}</span>
            <span className="voice__text">{entry.text}</span>
          </div>
        ))}
      </div>

      <Models />
    </div>
  );
}

const TONE_GLYPH = {
  heard: "🗣",
  done: "✓",
  error: "✕",
  info: "…",
} as const;

function Meter({ level }: { level: number }) {
  // RMS of speech tops out well under 1.0 — scale so a normal voice fills
  // most of the bar.
  const width = Math.min(100, Math.round(level * 400));
  return (
    <span className="voice__meter">
      <span className="voice__meter-fill" style={{ width: `${width}%` }} />
    </span>
  );
}

/** The model manager: registry rows with install state, a download button
 * with live progress, and the active-model pick (stored per plugin). */
function Models() {
  const { ctx } = runtime();
  const [models, setModels] = useState<VoiceModelInfo[] | null>(null);
  const [active, setActive] = useState<string>(DEFAULT_MODEL);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    ctx.services.voice
      .models()
      .then(setModels)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void refresh();
    void ctx.storage.global
      .get<string>(MODEL_KEY)
      .then((v) => v && setActive(v));
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

  const pick = (id: string) => {
    setActive(id);
    void ctx.storage.global.set(MODEL_KEY, id);
  };

  return (
    <div className="voice__models">
      <div className="voice__models-title">Models</div>
      {error && <div className="voice__entry voice__entry--error">{error}</div>}
      {models?.map((m) => (
        <div key={m.id} className="voice__model">
          <label className="voice__model-pick">
            <input
              type="radio"
              name="voice-model"
              checked={active === m.id}
              disabled={!m.installed}
              onChange={() => pick(m.id)}
            />
            <span>
              {m.label} <span className="voice__model-size">{m.sizeMb} MB</span>
            </span>
          </label>
          {m.installed ? (
            <button
              type="button"
              className="voice__model-btn"
              onClick={() =>
                void ctx.services.voice.deleteModel(m.id).then(refresh)
              }
            >
              Delete
            </button>
          ) : progress[m.id] !== undefined ? (
            <span className="voice__model-progress">{progress[m.id]}%</span>
          ) : (
            <button
              type="button"
              className="voice__model-btn"
              onClick={() => download(m.id)}
            >
              Download
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
