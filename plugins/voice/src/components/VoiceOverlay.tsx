import { useSyncExternalStore } from "react";
import { runtime } from "../runtime";
import { pillView } from "../tabView";
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
  const pill = pillView(snap.phase, snap.mode);
  if (!pill.visible) return null;

  return (
    <div className="voice-pill kd-float" role="status">
      <span className={`voice-pill__dot${pill.live ? " voice-pill__dot--live" : ""}`} />
      <span className="voice-pill__label">{pill.label}</span>
      {mic.showMeter && <MicMeter status={mic} className="voice-pill__meter" />}
    </div>
  );
}
