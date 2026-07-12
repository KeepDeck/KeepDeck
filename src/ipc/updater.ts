import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type { DownloadEvent, Update };

/** Ask the updater plugin whether the rolling release is newer than this
 * build. Resolves `null` when we're current; rejects when the plugin is not
 * registered (dev builds) or the check itself failed. */
export function checkForUpdate(): Promise<Update | null> {
  return check();
}

/** Spawn a fresh app process and exit this one — the last step of an update
 * (the new bundle was already swapped into place by `Update.install`). */
export function relaunchApp(): Promise<void> {
  return relaunch();
}
