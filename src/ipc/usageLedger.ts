import { invoke } from "@tauri-apps/api/core";
import type { UsageCallBatch } from "../domain/usage/history/capture";
import type { UsageRow } from "../domain/usage/history/event";

/** The ledger the core serves: history compacted into buckets, the last
 * hours as recorded events, every row priced. */
export interface StoredUsageLedger {
  rows: UsageRow[];
  /** False when the store left out history it could not read. */
  complete: boolean;
  /** When the core began booking per model; rows before it count every
   * session as one sum, under the model name its agent showed. */
  perModelSince: number | null;
}

/** One pane's calls for the core to book. */
export interface UsageBookEntry {
  batch: UsageCallBatch;
  capturedAt: number;
}

export function loadUsageLedger(): Promise<StoredUsageLedger> {
  return invoke<StoredUsageLedger>("usage_ledger");
}

/** Book one pane's calls: the rows they add to the ledger — none when every
 * call was booked already or is not the deck's to book. A booking only adds
 * rows, so appending every answer keeps the page's rows summing to the
 * core's ledger. */
export function bookUsageCalls(entry: UsageBookEntry): Promise<UsageRow[]> {
  return invoke<UsageRow[]>("usage_book_calls", { entry });
}

/** From when (unix ms) a followed file of this session must be read again:
 * the core's answer from what it has booked of it. */
export function usageSince(agent: string, sessionId: string, firstSeen: number): Promise<number> {
  return invoke<number>("usage_since", { agent, sessionId, firstSeen });
}
