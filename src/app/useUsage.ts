import { useSyncExternalStore } from "react";
import {
  getUsageSnapshot,
  subscribeUsage,
  type UsageSnapshot,
} from "./usageManager";

/** The live usage snapshot — read-only, mount anywhere (chips, popover,
 * pane badges). The write side is `useUsageChannel`, mounted once. */
export function useUsage(): UsageSnapshot {
  return useSyncExternalStore(subscribeUsage, getUsageSnapshot);
}
