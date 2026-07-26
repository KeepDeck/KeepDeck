import {
  DownloadManager,
  tauriDownloadBackend,
  type DownloadBackend,
} from "./downloadManager";
import { createPluginManager } from "./pluginManager";
import { createFileOpenManager } from "./fileOpenManager";
import { createDeckStore } from "./deckStore";
import { createSpawnContextSource } from "./spawnContextSource";
import {
  createAgentOrchestrator,
  type AgentCatalogPort,
} from "./agentOrchestrator";
import { getSettings, subscribeSettings } from "./settingsManager";
import { openPath } from "../ipc/app";
import { probeWorktree } from "../ipc/worktree";
import { log } from "../ipc/log";

/** The agent catalog as the orchestrator needs it: the ids cli plugins
 * currently contribute, live. Only the ids — whether the binary is installed
 * is the dialog's concern, not the wake decision's (a pane whose agent is
 * contributed but missing fails visibly in its terminal, which is the honest
 * place for it). */
function agentCatalogPort(
  plugins: ReturnType<typeof createPluginManager>,
): AgentCatalogPort {
  const registry = plugins.pluginRegistries.agents;
  return {
    ids: () => new Set(registry.list().map((c) => c.entry.id)),
    ready: () => plugins.bootstrapPlugins(),
    subscribe: registry.subscribe,
  };
}

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
  // The deck's state owner. It lives HERE, not in `useDeck`, because code
  // outside React has to read and dispatch against the same state — the agent
  // orchestrator drives pane lifecycles whether or not any component is
  // mounted, and a store created inside a component would tie the deck's
  // lifetime (and the processes it describes) to a render tree.
  const deckStore = createDeckStore();
  // Loads on construction, for the same reason the deck store lives here: the
  // resume plans built from it are prepared before any terminal mounts.
  const spawnContext = createSpawnContextSource();
  return {
    downloads,
    plugins,
    deckStore,
    spawnContext,
    /** One per app: pane ids are minted app-wide, sessions are keyed by them,
     * and a request can name a pane in a workspace that is not on screen. */
    orchestrator: createAgentOrchestrator({
      deck: deckStore,
      spawnContext,
      agents: agentCatalogPort(plugins),
      launchPolicy: {
        parkOnLaunch: () => getSettings()?.parkAgentsOnLaunch ?? false,
        subscribe: subscribeSettings,
      },
      plugins,
      probe: probeWorktree,
    }),
    fileOpen: createFileOpenManager(
      () => plugins.pluginRegistries.fileOpeners.list(),
      openPath,
      (message) => log.warn("web:file-open", message),
    ),
  };
}

export type AppRuntime = ReturnType<typeof createAppRuntime>;
