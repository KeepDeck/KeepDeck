import { useSyncExternalStore } from "react";
import { contextPct } from "../domain/usage";
import { getUsageSnapshot, subscribeUsage } from "./usageManager";

/**
 * The live context-occupancy percentage for ONE pane — or undefined when the
 * pane has reported no context yet. A NARROW selector over the usage store:
 * `getSnapshot` returns a primitive, so `useSyncExternalStore` re-renders the
 * caller only when THIS pane's context% actually changes — not the whole deck
 * on every unrelated usage tick. Mirrors [`useUsage`]'s external-store wiring,
 * scoped to a single pane so each `AgentPane` can carry its own header meter.
 */
export function usePaneContextPct(paneId: string): number | undefined {
  return useSyncExternalStore(subscribeUsage, () =>
    contextPct(getUsageSnapshot().panes.get(paneId)?.context),
  );
}
