import { invoke } from "@tauri-apps/api/core";

/**
 * Durable app settings ([F6]). The JSON is opaque to the Rust side — schema,
 * validation and per-key tolerance live in `src/domain/settings`; these
 * commands only move the bytes (atomically, in the KeepDeck home).
 */

/** The stored settings JSON, or `null` on first run. */
export function loadSettings(): Promise<string | null> {
  return invoke<string | null>("settings_load");
}

/** Persist the serialized settings (atomic tmp+rename on the Rust side). */
export function saveSettings(json: string): Promise<void> {
  return invoke("settings_save", { json });
}

/** Preserve an unusable stored settings file as `settings.json.bak` — it's
 * hand-editable, so a typo must stay inspectable instead of being overwritten
 * by the next save. */
export function quarantineSettings(): Promise<void> {
  return invoke("settings_quarantine");
}

/** Keep a COPY of the stored settings as a rotating `.bak.<millis>` sibling,
 * leaving the live document in place. Taken before an app update: settings that
 * come back changed afterwards can otherwise neither be proved nor restored,
 * since the file carries no history of its own. */
export function snapshotSettings(): Promise<void> {
  return invoke("settings_snapshot");
}
