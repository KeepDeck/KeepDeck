import { useEffect, useState } from "react";
import {
  EMPTY_SPAWN_CONTEXT,
  type SpawnPlanContext,
} from "../domain/spawnPlans";
import { spawnContext } from "../ipc/sessions";

/**
 * The per-install spawn-plan context ([F7]/[F8] v2), loaded once at boot.
 * `null` while loading — the deck gates its first paint on it (a pane spawned
 * without its plan would miss its session identity). A failed load degrades
 * to [`EMPTY_SPAWN_CONTEXT`]: agents still spawn, identity mechanisms are off.
 */
export function useSpawnContext(): SpawnPlanContext | null {
  const [ctx, setCtx] = useState<SpawnPlanContext | null>(null);
  useEffect(() => {
    let cancelled = false;
    void spawnContext()
      .catch(() => EMPTY_SPAWN_CONTEXT)
      .then((loaded) => {
        if (!cancelled) setCtx(loaded);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return ctx;
}
