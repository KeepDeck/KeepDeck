import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import type { DownloadRequest } from "@keepdeck/plugin-api";

interface AvailableUpdateDto {
  id: string;
  version: string;
  url: string;
  signature: string;
  publicKey: string;
  target: string;
  downloaded: boolean;
}

export interface AvailableUpdate {
  id: string;
  version: string;
  downloaded: boolean;
  download: Omit<DownloadRequest, "id">;
}

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const update = await invoke<AvailableUpdateDto | null>("app_update_check");
  if (!update) return null;
  return {
    id: update.id,
    version: update.version,
    downloaded: update.downloaded,
    download: {
      source: { url: update.url },
      target: { kind: "file", path: update.target },
      integrity: {
        kind: "minisign",
        signature: update.signature,
        publicKey: update.publicKey,
      },
    },
  };
}

export function installUpdate(id: string): Promise<void> {
  return invoke("app_update_install", { id });
}

export function discardUpdate(id: string): Promise<void> {
  return invoke("app_update_discard", { id });
}

export function relaunchApp(): Promise<void> {
  return relaunch();
}
