import { DownloadManager, tauriDownloadBackend } from "./downloadManager";

/**
 * App composition root. The manager itself is an ordinary constructible class;
 * this runtime owns one instance because plugins and the updater share one
 * process-wide target/id registry.
 */
export const appDownloads = new DownloadManager(tauriDownloadBackend);
