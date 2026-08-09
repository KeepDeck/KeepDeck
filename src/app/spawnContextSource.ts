import {
  EMPTY_SPAWN_CONTEXT,
  type SpawnPlanContext,
} from "./spawnSpecs";
import { describeError, log } from "../ipc/log";
import { paneBridgeDir, spawnContext } from "../ipc/sessions";

/**
 * The per-install spawn-plan context ([F7]/[F8] v2), loaded once at boot and
 * readable from anywhere.
 *
 * It belongs to the app runtime rather than to a component: a resume plan
 * built without it would miss the agent's identity mechanism, and the code
 * that builds those plans has to work whether or not the pane is rendered.
 * Constructed, not a module singleton, so a test builds its own with its own
 * loader instead of resetting shared state.
 */
export interface SpawnContextSource {
  /** The loaded context, or null while the boot load is still out. Callers
   * that spawn MUST wait for a non-null value. */
  get(): SpawnPlanContext | null;
  subscribe(listener: () => void): () => void;
}

export function createSpawnContextSource(
  // The DTO half only — the per-pane inbox is a CALL, not a constant, so it
  // is composed here rather than carried across the IPC boundary.
  load: () => Promise<{ bridgeDir: string }> = spawnContext,
  perPaneDir: (paneId: string) => Promise<string> = paneBridgeDir,
): SpawnContextSource {
  let ctx: SpawnPlanContext | null = null;
  const listeners = new Set<() => void>();
  void load()
    .then((dto) => ({ ...dto, paneBridgeDir: perPaneDir }))
    .catch((e) => {
      // Identity mechanisms silently off is exactly the state that burned an
      // hour once — make the degradation visible.
      log.warn(
        "web:spawn-context",
        `load failed, identity off: ${describeError(e)}`,
      );
      return EMPTY_SPAWN_CONTEXT;
    })
    .then((loaded) => {
      ctx = loaded;
      for (const listener of [...listeners]) listener();
    });
  return {
    get: () => ctx,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
