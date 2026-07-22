import { useSyncExternalStore } from "react";
import {
  getUsageHistorySnapshot,
  subscribeUsageHistory,
  type UsageHistorySnapshot,
} from "./usageHistoryManager";

/** Read-only durable usage history for the global Usage statistics screen. */
export function useUsageHistorySnapshot(): UsageHistorySnapshot {
  return useSyncExternalStore(
    subscribeUsageHistory,
    getUsageHistorySnapshot,
    getUsageHistorySnapshot,
  );
}
