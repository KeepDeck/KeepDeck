import {
  DownloadManager,
  tauriDownloadBackend,
  type DownloadBackend,
} from "./downloadManager";
import { createPluginManager } from "./pluginManager";
import { createFileOpenManager } from "./fileOpenManager";
import { openPath } from "../ipc/app";
import { log } from "../ipc/log";

/**
 * App composition root. The manager itself is an ordinary constructible class;
 * this runtime owns one instance because plugins and the updater share one
 * process-wide target/id registry.
 */
export function createAppRuntime(
  downloadBackend: DownloadBackend = tauriDownloadBackend,
) {
  const downloads = new DownloadManager(downloadBackend);
  const plugins = createPluginManager(downloads);
  return {
    downloads,
    plugins,
    fileOpen: createFileOpenManager(
      () => plugins.pluginRegistries.fileOpeners.list(),
      openPath,
      (message) => log.warn("web:file-open", message),
    ),
  };
}

export type AppRuntime = ReturnType<typeof createAppRuntime>;
