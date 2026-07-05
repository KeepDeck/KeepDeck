import { useSyncExternalStore } from "react";
import type { RunSession } from "../domain/runSessions";
import { getRunSessions, subscribeRuns } from "./runManager";

/**
 * The live run sessions — a React bridge over the `runManager` singleton.
 * Returns the full stable snapshot; callers filter by workspace in render
 * (filtering here would mint a fresh array per call and break the
 * `useSyncExternalStore` snapshot contract).
 */
export function useRunSessions(): RunSession[] {
  return useSyncExternalStore(subscribeRuns, getRunSessions);
}
