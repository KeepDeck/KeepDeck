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
  /** When the core began booking reports per model; rows before it count
   * every session as one sum, under the model name its agent showed. */
  perModelSince: number | null;
}

/** One pane report for the core to book. */
export interface UsageRecordEntry {
  report: Pick<
    PaneUsage,
    "agent" | "model" | "totalTokens" | "costUsd" | "byModel" | "reportedAt" | "sequence"
  >;
  context: UsageCaptureContext;
  capturedAt: number;
}

export function loadUsageLedger(): Promise<StoredUsageLedger> {
  return invoke<StoredUsageLedger>("usage_ledger");
}

/** Book one report: the rows it adds to the ledger — none when there was
 * nothing to book, one per model that moved and one for its price when it
 * counts per model. A booking only adds rows, so appending every answer
 * keeps the page's rows summing to the core's ledger. */
export function recordUsage(entry: UsageRecordEntry): Promise<UsageRow[]> {
  return invoke<UsageRow[]>("usage_record", { entry });
}
