import { invoke } from "@tauri-apps/api/core";

/**
 * External plugin discovery. Bytes only — the Rust side reads each
 * installed plugin's `manifest.json` (raw, off disk for a dev folder or
 * straight out of a validated `.kdplugin`'s zip entry table for an archive)
 * under `<config_dir>/plugins` and checks nothing beyond "is it JSON";
 * schema validation is `readManifest`'s job (`@keepdeck/plugin-api`),
 * matching how the deck's own persistence keeps schema knowledge next to
 * the model it mirrors (see `src/ipc/state.ts`).
 */

/** Mirrors the Rust `InstalledPluginRecord` (camelCase). The location name
 *  is cosmetic — a plugin's real identity is its manifest's `id` — but the
 *  TS loader needs it to build its own id -> location map for `kdplugin://`
 *  URLs (see `src/plugins/external/url.ts`). */
export interface InstalledPluginRecord {
  /** A dev folder's name, or a `.kdplugin` file's name (extension
   *  included) — whichever `source` says this record is. */
  dirName: string;
  manifestJson: string;
  /** Whether the plugin ships a `main.js` entry (the fixed convention). The
   *  webview can't stat the plugin's files, so the scan reports it: present →
   *  the host boots a logic realm; absent → a pure-UI plugin, no realm. */
  hasMain: boolean;
  /** Which of the two installed-plugin shapes this is: a packaged
   *  `.kdplugin` container, or an unpacked dev folder. A dev folder always
   *  wins over an archive declaring the same id — see `resolvePluginDir`
   *  and `docs/plugin-container.md`. */
  source: "archive" | "dev";
}

/** Every installed plugin's raw manifest: every validated `.kdplugin`
 *  archive first (sorted by file name), then every dev folder (sorted by
 *  folder name) — see the Rust `plugins_scan` doc comment for why the two
 *  tiers are kept in that fixed relative order rather than merged by name.
 *  An absent or empty plugins folder resolves to `[]`, never a rejection. */
export function scanPlugins(): Promise<InstalledPluginRecord[]> {
  return invoke<InstalledPluginRecord[]>("plugins_scan");
}

/** The folder or `.kdplugin` file currently serving plugin `id`, or `null`
 *  if none does. Re-scans (and, for an archive, re-validates) on every
 *  call; a dev folder wins over an archive declaring the same id, with
 *  ties within a tier broken by `scanPlugins`'s sort order. */
export function resolvePluginDir(id: string): Promise<string | null> {
  return invoke<string | null>("plugins_resolve_dir", { id });
}
