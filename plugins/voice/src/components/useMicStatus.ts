import { useEffect, useState, useSyncExternalStore } from "react";
import type { VoiceController } from "../controller";
import { micStatus, type MicStatus } from "../micStatus";

/** The clock the meter reads its freshness from: ticks every frame while
 * listening (so a stalled device visibly drains the bar), still otherwise. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    let frame = requestAnimationFrame(function tick() {
      setNow(Date.now());
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [ticking]);
  return ticking ? now : Date.now();
}

/** The microphone's status for a component — the controller's snapshot
 * through `micStatus`, at the current moment. */
export function useMicStatus(controller: VoiceController): MicStatus {
  const snap = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const listening = snap.phase === "listening";
  const now = useNow(listening);
  return micStatus(
    {
      listening,
      device: snap.device,
      reading: snap.reading,
      readingAt: snap.readingAt,
      lastHold: snap.lastHold,
    },
    now,
  );
}
