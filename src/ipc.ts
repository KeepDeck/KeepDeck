import { invoke } from "@tauri-apps/api/core";

/** Mirrors the Rust `AppInfo` struct returned by the `app_info` command. */
export interface AppInfo {
  name: string;
  version: string;
}

/** Fetch build/runtime info from the Rust core (skeleton IPC smoke test). */
export function fetchAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}

/** For each dropped path, whether it's an image file (detected by content, not
 * extension) — so the UI can bracketed-paste images and type other paths raw. */
export function pathsAreImages(paths: string[]): Promise<boolean[]> {
  return invoke<boolean[]>("paths_are_images", { paths });
}
