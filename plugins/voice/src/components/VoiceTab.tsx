import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { runtime } from "../runtime";
import { HelpPopover, InfoIcon } from "./HelpPopover";

/**
 * The Voice dock tab: the chat-log of what was heard and what was done, the
 * mic toggle for command mode, and the model manager (download-on-demand —
 * weights are never bundled, the picker IS the install surface).
 */
export function VoiceTab() {
  const { ctx, controller, downloads, models: store } = runtime();
  const snap = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const dl = useSyncExternalStore(downloads.subscribe, downloads.snapshot);
  // Install state from the shared store — a delete in settings or a finished
  // download refreshes it, so this prompt appears/clears without reopening.
  const models = useSyncExternalStore(store.subscribe, store.snapshot);
  const hasModel = models === null ? null : models.some((m) => m.installed);
  const [helpAnchor, setHelpAnchor] = useState<HTMLElement | null>(null);
  const helpBtnRef = useRef<HTMLButtonElement | null>(null);
  // Hover intent: open after a short dwell, close after a grace period so
  // the cursor can travel from the button onto the card.
  const helpTimer = useRef<number | null>(null);
  const helpDelay = (action: () => void, ms: number) => {
    if (helpTimer.current !== null) window.clearTimeout(helpTimer.current);
    helpTimer.current = window.setTimeout(action, ms);
  };
  const helpHold = () => {
    if (helpTimer.current !== null) window.clearTimeout(helpTimer.current);
  };
  useEffect(() => helpHold, []);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [snap.history.length]);

  // No model installed (and none arriving): the whole surface is a prompt to
  // get one — voice can't do anything without a model. A download in flight
  // shows the strip instead, so the user sees progress here too.
  if (hasModel === false && !downloads.anyActive()) {
    return (
      <div className="voice voice__setup">
        <div className="voice__setup-title">No speech model yet</div>
        <div className="voice__setup-text">
          Voice commands and dictation need a local speech-to-text model.
          Download one to get started — it stays on your machine.
        </div>
        <button
          type="button"
          className="voice__setup-btn"
          onClick={() => void ctx.commands.execute("settings.open", {})}
        >
          Choose a model…
        </button>
      </div>
    );
  }

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
        <button
          type="button"
          ref={helpBtnRef}
          className={`voice__info${helpAnchor ? " voice__info--on" : ""}`}
          onMouseEnter={() =>
            helpDelay(() => setHelpAnchor(helpBtnRef.current), 450)
          }
          onMouseLeave={() => helpDelay(() => setHelpAnchor(null), 150)}
          onClick={() => {
            helpHold();
            setHelpAnchor(helpAnchor ? null : helpBtnRef.current);
          }}
          aria-label="How to use voice"
        >
          <InfoIcon />
        </button>
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
      {snap.phase !== "idle" && (
        <div className="voice__status">
          {snap.phase === "listening"
            ? `listening — release to ${snap.mode === "dictation" ? "send" : "run"}, Esc cancels`
            : "transcribing…"}
        </div>
      )}
      {helpAnchor && (
        <HelpPopover
          anchor={helpAnchor}
          onClose={() => setHelpAnchor(null)}
          onPointerStay={helpHold}
          onPointerLeave={() => helpDelay(() => setHelpAnchor(null), 150)}
        />
      )}

      <DownloadStrip active={dl.active} />

      <div className="voice__log" ref={logRef}>
        {snap.history.length === 0 && (
          <div className="voice__empty">
            Hold <kbd>⌥Space</kbd> and say a command, or <kbd>⌥⇧Space</kbd> to
            dictate. Hover <span className="voice__empty-i">ⓘ</span> for the
            list.
          </div>
        )}
        {snap.history.map((entry) => (
          <div key={`${entry.at}-${entry.text}`} className={`voice__entry voice__entry--${entry.tone}`}>
            <span className="voice__tone">{TONE_GLYPH[entry.tone]}</span>
            <span className="voice__text">{entry.text}</span>
          </div>
        ))}
      </div>

    </div>
  );
}

const TONE_GLYPH = {
  heard: "🗣",
  done: "✓",
  error: "✕",
  info: "…",
} as const;

/** A model download is running somewhere — surface it in the dock, since the
 * transfer started in settings outlives that dialog. Cancel lives here too,
 * so the tab is a real download surface, not just an indicator. */
function DownloadStrip({
  active,
}: {
  active: Readonly<Record<string, { percent: number | null }>>;
}) {
  const { downloads } = runtime();
  const ids = Object.keys(active);
  if (ids.length === 0) return null;
  return (
    <div className="voice__downloads">
      {ids.map((id) => {
        const percent = active[id].percent;
        return (
          <div key={id} className="voice__download">
            <span className="voice__download-name">
              Downloading {modelName(id)}…{percent !== null && ` ${percent}%`}
            </span>
            <button
              type="button"
              className="voice__model-btn"
              onClick={() => downloads.cancel(id)}
              title="Stop — the next Download resumes from here"
            >
              ✕
            </button>
            <span className="voice-models__bar">
              <span
                className="voice-models__bar-fill"
                style={
                  percent === null
                    ? { width: "100%", opacity: 0.4 }
                    : { width: `${percent}%` }
                }
              />
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A readable model name from its id, without threading the registry here. */
function modelName(id: string): string {
  if (id.startsWith("parakeet")) return "Parakeet v3";
  if (id.includes("turbo")) return "Whisper Turbo";
  if (id.includes("small")) return "Whisper Small";
  return id;
}

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
