import { useSyncExternalStore } from "react";
import type { RunSession } from "../domain";
import { getRuntime } from "../runtime";

/**
 * The live run sessions — a React bridge over the activation's run manager.
 * Returns the full stable snapshot; callers filter by workspace in render
 * (filtering here would mint a fresh array per call and break the
 * `useSyncExternalStore` snapshot contract).
 */
export function useRunSessions(): RunSession[] {
  const { manager } = getRuntime();
  return useSyncExternalStore(manager.subscribe, manager.getSessions);
}
