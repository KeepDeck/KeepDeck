import { invoke } from "@tauri-apps/api/core";

/**
 * Durable deck state ([F7]). The JSON is opaque to the Rust side — schema,
 * validation and migrations live in `src/domain/deck/persist.ts`; these commands
 * only move the bytes (atomically, in the app config dir).
 */

/** The stored deck JSON, or `null` on first run. */
export function loadDeckState(): Promise<string | null> {
  return invoke<string | null>("deck_state_load");
}

/** Persist the serialized deck (atomic tmp+rename on the Rust side). */
export function saveDeckState(json: string): Promise<void> {
  return invoke("deck_state_save", { json });
}

/** Preserve an unusable stored deck as `deck.json.bak` instead of letting the
 * next save overwrite the evidence. */
export function quarantineDeckState(): Promise<void> {
  return invoke("deck_state_quarantine");
}
