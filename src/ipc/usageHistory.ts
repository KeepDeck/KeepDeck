import { invoke } from "@tauri-apps/api/core";

/** Native persistence for canonical usage deltas. Lines are opaque to Rust;
 * the domain codec owns schema and tolerant recovery. */
export function loadUsageHistory(): Promise<string[]> {
  return invoke<string[]>("usage_history_load");
}

/** Append as one ordered, fsynced write. */
export function appendUsageHistory(lines: string[]): Promise<void> {
  return invoke("usage_history_append", { lines });
}

/** Atomic retention/deduplication rewrite. */
export function compactUsageHistory(lines: string[]): Promise<void> {
  return invoke("usage_history_compact", { lines });
}
