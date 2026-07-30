import { skillRootsOf } from "../domain/deck";
import { openPath } from "../ipc/app";
import { log } from "../ipc/log";
import { probeWorktree } from "../ipc/worktree";
import {
  createAgentOrchestrator,
  type AgentCatalogPort,
} from "./agentOrchestrator";
import { createApplicationController } from "./applicationController";
import { createDeckPersistence } from "./deckPersistence";
import { createDeckStore } from "./deckStore";
import {
  DownloadManager,
  tauriDownloadBackend,
  type DownloadBackend,
} from "./downloadManager";
import { createFileOpenManager } from "./fileOpenManager";
import { createJournalPersistence } from "./journalPersistence";
import { createMinimizePolicy } from "./minimizePolicy";
import { createPluginDeckBridge } from "./pluginDeckBridge";
import { createPluginManager } from "./pluginManager";
import {
  acquirePane,
  closePane,
  paneSessionState,
  runPaneOnce,
  subscribeSessions,
} from "./ptyManager";
import { createSessionBinding } from "./sessionBinding";
import { getSettings, subscribeSettings } from "./settingsManager";
import { createSpawnContextSource } from "./spawnContextSource";
import { createUsageChannel } from "./usageChannel";
import { createWorktreeManager } from "./worktrees";
import { createWorktreeSweeper } from "./worktreeSweeper";

/** The live agent contributions as the orchestrator needs them. */
function agentCatalogPort(
  plugins: ReturnType<typeof createPluginManager>,
): AgentCatalogPort {
  const registry = plugins.pluginRegistries.agents;
  return {
    commands: () =>
      new Map(registry.list().map((c) => [c.entry.id, c.entry.detect.bin])),
    ready: () => plugins.bootstrapPlugins(),
    subscribe: registry.subscribe,
  };
}

/** Application composition root and owner of app-lifetime services. */
export function createAppRuntime(
  downloadBackend: DownloadBackend = tauriDownloadBackend,
) {
  const downloads = new DownloadManager(downloadBackend);
  const plugins = createPluginManager(downloads);
  const deckStore = createDeckStore();
  const deckPersistence = createDeckPersistence(deckStore);
  const minimizePolicy = createMinimizePolicy(deckStore, {
    minimizeStyle: () => getSettings()?.minimizeStyle ?? null,
    subscribe: subscribeSettings,
  });
  const journalPersistence = createJournalPersistence(
    deckStore,
    deckPersistence,
  );
  let sessionBinding: ReturnType<typeof createSessionBinding> | null = null;
  const spawnContext = createSpawnContextSource();
  const worktrees = createWorktreeManager({
    rootsOf: (ref) => {
      const workspace = deckStore
        .getSnapshot()
        .workspaces.find(
          (candidate) =>
            candidate.id === ref.id && candidate.instance === ref.instance,
        );
      return workspace ? skillRootsOf(workspace) : [];
    },
    live: () =>
      deckStore
        .getSnapshot()
        .workspaces.map((workspace) => ({
          id: workspace.id,
          roots: skillRootsOf(workspace),
        })),
  });
  const orchestrator = createAgentOrchestrator({
    deck: deckStore,
    spawnContext,
    agents: agentCatalogPort(plugins),
    launchPolicy: {
      parkOnLaunch: () => getSettings()?.parkAgentsOnLaunch ?? false,
      subscribe: subscribeSettings,
    },
    suspendPolicy: {
      moveToTray: () =>
        getSettings()?.suspendedAgentPlacement === "tray",
    },
    sessions: {
      subscribe: subscribeSessions,
      state: paneSessionState,
      acquire: acquirePane,
      close: closePane,
      runOnce: runPaneOnce,
    },
    plugins,
    probe: probeWorktree,
    worktrees,
  });
  const application = createApplicationController(
    deckStore,
    plugins,
    orchestrator,
  );
  const worktreeSweeper = createWorktreeSweeper(
    deckStore,
    deckPersistence,
    worktrees,
  );
  const pluginDeckBridge = createPluginDeckBridge(deckStore, plugins);
  let usageChannel: ReturnType<typeof createUsageChannel> | null = null;
  let disposed = false;

  return {
    downloads,
    plugins,
    deckStore,
    deckPersistence,
    spawnContext,
    worktrees,
    application,
    start() {
      if (disposed) return;
      sessionBinding ??= createSessionBinding(deckStore);
      usageChannel ??= createUsageChannel(
        deckStore,
        plugins.pluginRegistries.agents,
      );
      application.start();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      application.dispose();
      usageChannel?.dispose();
      pluginDeckBridge.dispose();
      worktreeSweeper.dispose();
      minimizePolicy.dispose();
      journalPersistence.dispose();
      sessionBinding?.dispose();
      deckPersistence.dispose();
    },
    orchestrator,
    fileOpen: createFileOpenManager(
      () => plugins.pluginRegistries.fileOpeners.list(),
      openPath,
      (message) => log.warn("web:file-open", message),
    ),
  };
}

export type AppRuntime = ReturnType<typeof createAppRuntime>;
