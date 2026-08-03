import { useSyncExternalStore } from "react";
import type { SpawnPlanContext } from "./spawnSpecs";
import type { SpawnContextSource } from "./spawnContextSource";

/**
 * Read the app's spawn-plan context in React. `null` while the boot load is
 * still out — the deck gates its first paint on it, since a pane spawned
 * without its plan would miss its session identity.
 *
 * A subscription rather than a load of its own: the context belongs to the
 * runtime, because the plans built from it outlive any component. The failed-
 * load degradation (agents still spawn, identity mechanisms off) lives with
 * the source, in [`createSpawnContextSource`].
 */
export function useSpawnContext(
  source: SpawnContextSource,
): SpawnPlanContext | null {
  return useSyncExternalStore(source.subscribe, source.get, source.get);
}
