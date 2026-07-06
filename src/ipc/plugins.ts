import { invoke } from "@tauri-apps/api/core";

/**
 * External plugin discovery. Bytes only — the Rust side reads each
 * installed plugin's `manifest.json` under `<config_dir>/plugins` raw and
 * checks nothing beyond "is it JSON"; schema validation is `readManifest`'s
 * job (`@keepdeck/plugin-api`), matching how the deck's own persistence
 * keeps schema knowledge next to the model it mirrors (see `src/ipc/state.ts`).
 */

/** Mirrors the Rust `InstalledPluginRecord` (camelCase). The folder name is
 *  cosmetic — a plugin's real identity is its manifest's `id` — but the TS
 *  loader needs the folder to build its own id -> folder map for
 *  `kdplugin://` URLs (see `src/plugins/external/url.ts`). */
export interface InstalledPluginRecord {
  dirName: string;
  manifestJson: string;
}

/** Every installed plugin's raw manifest, sorted by folder name. An absent
 *  or empty plugins folder resolves to `[]`, never a rejection. */
export function scanPlugins(): Promise<InstalledPluginRecord[]> {
  return invoke<InstalledPluginRecord[]>("plugins_scan");
}

/** The folder currently serving plugin `id`, or `null` if none does.
 *  Re-scans on every call; first-wins when two folders' manifests declare
 *  the same id (same rule `scanPlugins`'s order encodes). */
export function resolvePluginDir(id: string): Promise<string | null> {
  return invoke<string | null>("plugins_resolve_dir", { id });
}
