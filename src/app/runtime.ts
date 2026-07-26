import {
  DownloadManager,
  tauriDownloadBackend,
  type DownloadBackend,
} from "./downloadManager";
import { createPluginManager } from "./pluginManager";
import { createFileOpenManager } from "./fileOpenManager";
import { createDeckStore } from "./deckStore";
import { createSpawnContextSource } from "./spawnContextSource";
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
    // The deck's state owner. It lives HERE, not in `useDeck`, because code
    // outside React has to read and dispatch against the same state — the
    // agent orchestrator drives pane lifecycles whether or not any component
    // is mounted, and a store created inside a component would tie the deck's
    // lifetime (and the processes it describes) to a render tree.
    deckStore: createDeckStore(),
    // Loads on construction, for the same reason the deck store lives here:
    // the resume plans built from it are prepared before any terminal mounts.
    spawnContext: createSpawnContextSource(),
    fileOpen: createFileOpenManager(
      () => plugins.pluginRegistries.fileOpeners.list(),
      openPath,
      (message) => log.warn("web:file-open", message),
    ),
  };
}

export type AppRuntime = ReturnType<typeof createAppRuntime>;
