import { useSyncExternalStore } from "react";
import { runtime } from "../runtime";

/**
 * The listening pill — a resident overlay the host keeps mounted; renders
 * nothing while idle. In-window for the MVP (a system-level NSPanel that
 * floats over other apps comes later); commands are given while looking at
 * the deck, so the pill is where the eyes already are.
 */
export function VoiceOverlay() {
  const { controller } = runtime();
  const snap = useSyncExternalStore(controller.subscribe, controller.snapshot);
  if (snap.phase === "idle") return null;

  const width = Math.min(100, Math.round(snap.level * 400));
  return (
    <div className="voice-pill" role="status">
      <span
        className={`voice-pill__dot${
          snap.phase === "listening" ? " voice-pill__dot--live" : ""
        }`}
      />
      <span className="voice-pill__label">
        {snap.phase === "listening"
          ? snap.mode === "dictation"
            ? "Dictating — release to send"
            : "Listening — release to run"
          : "Transcribing…"}
      </span>
      {snap.phase === "listening" && (
        <span className="voice-pill__meter">
          <span className="voice-pill__meter-fill" style={{ width: `${width}%` }} />
        </span>
      )}
    </div>
  );
}
