import { useSyncExternalStore } from "react";
import type { PaneActivity } from "../domain/status";
import { useAppRuntime } from "./runtimeContext";

/**
 * The live activity of ONE pane's agent — or undefined when it has reported
 * no turn edge yet. A NARROW selector over the runtime's status tracker:
 * the map holds one stable object per pane between changes, so
 * `useSyncExternalStore` re-renders the caller only when THIS pane's
 * activity object is replaced — not the whole deck on every unrelated
 * status tick. The sibling of [`usePaneContextPct`].
 */
export function usePaneActivity(paneId: string): PaneActivity | undefined {
  const { statusTracker } = useAppRuntime();
  return useSyncExternalStore(statusTracker.subscribe, () =>
    statusTracker.getSnapshot().panes.get(paneId),
  );
}
