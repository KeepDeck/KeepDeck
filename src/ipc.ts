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
