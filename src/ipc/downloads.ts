import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  DownloadRequest,
  DownloadState,
  DownloadTarget,
  LegacyDownloadRequest,
} from "@keepdeck/plugin-api";

export function startDownload(
  request: DownloadRequest,
  onState: (state: DownloadState) => void,
  policy?: { allowedDomains?: readonly string[] },
): Promise<void> {
  const channel = new Channel<DownloadState>();
  channel.onmessage = onState;
  return invoke("download_start", {
    request,
    onState: channel,
    allowedDomains: policy?.allowedDomains ?? null,
  });
}

export function cancelDownload(id: string): Promise<void> {
  return invoke("download_cancel", { id });
}

export function downloadExists(target: DownloadTarget): Promise<boolean> {
  return invoke<boolean>("download_exists", { target });
}

export function removeDownload(target: DownloadTarget): Promise<void> {
  return invoke("download_remove", { target });
}

export function adoptLegacyDownload(request: LegacyDownloadRequest): Promise<void> {
  return invoke("download_adopt_legacy", { request });
}
