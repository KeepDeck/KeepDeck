import { useSyncExternalStore } from "react";
import { contextPct } from "../domain/usage";
import { useAppRuntime } from "./runtimeContext";

/**
 * The live context-occupancy percentage for ONE pane — or undefined when the
 * pane has reported no context yet. A NARROW selector over the usage store:
 * `getSnapshot` returns a primitive, so `useSyncExternalStore` re-renders the
 * caller only when THIS pane's context% actually changes — not the whole deck
 * on every unrelated usage tick. Mirrors [`useUsage`]'s external-store wiring,
 * scoped to a single pane so each `AgentPane` can carry its own header meter.
 */
export function usePaneContextPct(paneId: string): number | undefined {
  const { usageManager } = useAppRuntime();
  return useSyncExternalStore(usageManager.subscribe, () =>
    contextPct(usageManager.getSnapshot().panes.get(paneId)?.context),
  );
}
