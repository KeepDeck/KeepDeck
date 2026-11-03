import { invoke } from "@tauri-apps/api/core";
import type { PaneUsage } from "@keepdeck/plugin-api";
import type { UsageCaptureContext } from "../domain/usage/history/capture";
import type { UsageRow } from "../domain/usage/history/event";

/** The ledger the core serves: history compacted into buckets, the last
 * hours as recorded events. */
export interface StoredUsageLedger {
  rows: UsageRow[];
  /** False when the store left out history it could not read. */
  complete: boolean;
}

/** One pane report for the core to book. */
export interface UsageRecordEntry {
  report: Pick<PaneUsage, "agent" | "model" | "totalTokens" | "costUsd" | "reportedAt" | "sequence">;
  context: UsageCaptureContext;
  capturedAt: number;
}

export function loadUsageLedger(): Promise<StoredUsageLedger> {
  return invoke<StoredUsageLedger>("usage_ledger");
}

/** Book one report: the row it adds to the ledger, null when there was
 * nothing to book. A report completing a call reported in halves adds a row
 * with no count and no calls of its own — appending every answer keeps the
 * page's rows summing to the core's ledger. */
export function recordUsage(entry: UsageRecordEntry): Promise<UsageRow | null> {
  return invoke<UsageRow | null>("usage_record", { entry });
}
