import { useSyncExternalStore } from "react";
import { runtime } from "../runtime";
import { pillLabel } from "../tabView";
import { MicMeter } from "./MicBlock";
import { useMicStatus } from "./useMicStatus";

/**
 * The listening pill — a resident overlay the host keeps mounted; renders
 * nothing while idle. In-window for the MVP (a system-level NSPanel that
 * floats over other apps comes later); commands are given while looking at
 * the deck, so the pill is where the eyes already are.
 */
export function VoiceOverlay() {
  const { controller } = runtime();
  const snap = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const mic = useMicStatus(controller);
  if (snap.phase === "idle") return null;

  return (
    <div className="voice-pill kd-float" role="status">
      <span
        className={`voice-pill__dot${
          snap.phase === "listening" ? " voice-pill__dot--live" : ""
        }`}
      />
      <span className="voice-pill__label">{pillLabel(snap.phase, snap.mode)}</span>
      {snap.phase === "listening" && (
        <MicMeter status={mic} className="voice-pill__meter" />
      )}
    </div>
  );
}
