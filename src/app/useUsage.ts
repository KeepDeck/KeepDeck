import { useSyncExternalStore } from "react";
import { useAppRuntime } from "./runtimeContext";
import type { UsageSnapshot } from "./usageManager";

/** The live usage snapshot — read-only, mount anywhere (chips, popover,
 * pane badges). The write side is the runtime-owned `usageChannel`. */
export function useUsage(): UsageSnapshot {
  const { usageManager } = useAppRuntime();
  return useSyncExternalStore(
    usageManager.subscribe,
    usageManager.getSnapshot,
  );
}
