import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  DownloadRequest,
  DownloadIntegrity,
  LegacyDownloadMigration,
  DownloadState,
  DownloadTarget,
} from "@keepdeck/plugin-api";

export function startDownload(
  request: DownloadRequest,
  onState: (state: DownloadState) => void,
  constraints?: { allowedDomains?: readonly string[] },
): Promise<void> {
  const channel = new Channel<DownloadState>();
  channel.onmessage = onState;
  return invoke("download_start", {
    request,
    onState: channel,
    allowedDomains: constraints?.allowedDomains ?? null,
  });
}

export function cancelDownload(id: string): Promise<void> {
  return invoke("download_cancel", { id });
}

export function downloadExists(
  target: DownloadTarget,
  integrity?: DownloadIntegrity,
): Promise<boolean> {
  return invoke<boolean>("download_exists", { target, integrity: integrity ?? null });
}

export function removeDownload(target: DownloadTarget): Promise<void> {
  return invoke("download_remove", { target });
}

export function adoptPluginDownloads(
  pluginId: string,
  migration: LegacyDownloadMigration,
): Promise<void> {
  return invoke("plugin_adopt_legacy_downloads", {
    request: {
      ...migration,
      target: `plugins/${pluginId}/${migration.target}`,
    },
  });
}
