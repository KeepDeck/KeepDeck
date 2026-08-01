import { invoke } from "@tauri-apps/api/core";

/**
 * The already-congratulated achievement ids — a cache document like the
 * usage snapshot: the webview owns the schema and reads tolerantly; the
 * worst a bad file causes is one repeated congratulation.
 */

export function loadNotifiedAchievements(): Promise<string | null> {
  return invoke<string | null>("achievements_load");
}

export function saveNotifiedAchievements(json: string): Promise<void> {
  return invoke("achievements_save", { json });
}
