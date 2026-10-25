import { useSyncExternalStore } from "react";
import { contextPct } from "../domain/usage";
import { useAppRuntime } from "./runtimeContext";
import type { UsageManager } from "./usageManager";

/** The usage store as this selector reads it: its snapshot, and when that
 * changes. */
export type PaneUsageSource = Pick<UsageManager, "subscribe" | "getSnapshot">;

/**
 * The live context-occupancy percentage for ONE pane — or undefined when the
 * pane has reported no context yet. A NARROW selector over the usage store:
 * `getSnapshot` returns a primitive, so `useSyncExternalStore` re-renders the
 * caller only when THIS pane's context% actually changes — not the whole deck
 * on every unrelated usage tick. Mirrors [`useUsage`]'s external-store wiring,
 * scoped to a single pane so each `AgentPane` can carry its own header meter.
 */
export function usePaneContextPct(paneId: string): number | undefined {
  return usePaneContextPctFrom(useAppRuntime().usageManager, paneId);
}

/** [`usePaneContextPct`] over a usage store the caller names — the hook
 * itself, with the runtime's store as the one production source. */
export function usePaneContextPctFrom(
  usageManager: PaneUsageSource,
  paneId: string,
): number | undefined {
  return useSyncExternalStore(usageManager.subscribe, () =>
    contextPct(usageManager.getSnapshot().panes.get(paneId)?.context),
  );
}
