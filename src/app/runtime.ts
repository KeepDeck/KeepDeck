import { skillRootsOf } from "../domain/deck";
import { openPath } from "../ipc/app";
import { log } from "../ipc/log";
import { probeWorktree } from "../ipc/worktree";
import {
  loadNotifiedAchievements,
  saveNotifiedAchievements,
} from "../ipc/achievements";
import { createAchievementNotifier } from "./achievementNotifier";
import {
  createAgentOrchestrator,
  type AgentCatalogPort,
} from "./agentOrchestrator";
import { createAgentStatusChannel } from "./agentStatusChannel";
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
import { createMcpService } from "./mcpService";
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
import { notify } from "./notificationCenter";
import { createAgentStatusTracker } from "./agentStatusTracker";
import { createPaneTelemetry } from "./paneTelemetry";
import { getSettings, initSettings, subscribeSettings } from "./settingsManager";
import { createSpawnContextSource } from "./spawnContextSource";
import { createUsageChannel } from "./usageChannel";
import { createUsageManager } from "./usageManager";
import {
  getUsageHistorySnapshot,
  subscribeUsageHistory,
} from "./usageHistoryManager";
import { createWindowExhaustionNotifier } from "./windowExhaustionNotifier";
import { createAppWindowReportJournal } from "./windowReportJournal";
import { createWorktreeManager } from "./worktrees";
import { createWorktreeSweeper } from "./worktreeSweeper";
import { createPaneInputFocusController } from "../presentation/paneInputFocusController";
import { createPaneViewActions } from "../presentation/paneViewActions";

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
  const paneInputFocus = createPaneInputFocusController();
  const paneViewActions = createPaneViewActions(deckStore, paneInputFocus);
  const deckPersistence = createDeckPersistence(deckStore);
  const minimizePolicy = createMinimizePolicy(deckStore, {
    minimizeStyle: () => getSettings()?.minimizeStyle ?? null,
    subscribe: subscribeSettings,
  });
  const mcp = createMcpService({
    mcpServer: () => getSettings()?.mcpServer ?? null,
    subscribe: subscribeSettings,
  });
  const journalPersistence = createJournalPersistence(
    deckStore,
    deckPersistence,
  );
  let sessionBinding: ReturnType<typeof createSessionBinding> | null = null;
  const spawnContext = createSpawnContextSource();
  // The live telemetry stores (usage, activity) and the retire owner over
  // the pair. Runtime state like the deck store: the orchestrator retires
  // panes and the bridge channels report in with no component mounted.
  const usageManager = createUsageManager();
  const statusTracker = createAgentStatusTracker();
  const telemetry = createPaneTelemetry(usageManager, statusTracker);
  const windowReportJournal = createAppWindowReportJournal(usageManager);
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
    telemetry: { retire: telemetry.retire },
  });
  const application = createApplicationController(
    deckStore,
    plugins,
    orchestrator,
    paneInputFocus,
    paneViewActions,
  );
  const worktreeSweeper = createWorktreeSweeper(
    deckStore,
    deckPersistence,
    worktrees,
  );
  const pluginDeckBridge = createPluginDeckBridge(deckStore, plugins);
  let usageChannel: ReturnType<typeof createUsageChannel> | null = null;
  let statusChannel: ReturnType<typeof createAgentStatusChannel> | null = null;
  let achievementNotifier: ReturnType<typeof createAchievementNotifier> | null =
    null;
  let exhaustionNotifier: ReturnType<
    typeof createWindowExhaustionNotifier
  > | null = null;
  let disposed = false;

  return {
    downloads,
    plugins,
    deckStore,
    deckPersistence,
    spawnContext,
    worktrees,
    application,
    paneInputFocus,
    paneViewActions,
    mcp,
    usageManager,
    statusTracker,
    telemetry,
    windowReportJournal,
    start() {
      if (disposed) return;
      sessionBinding ??= createSessionBinding(deckStore, telemetry);
      usageChannel ??= createUsageChannel(
        deckStore,
        plugins.pluginRegistries.agents,
        usageManager,
      );
      statusChannel ??= createAgentStatusChannel(
        deckStore,
        plugins.pluginRegistries.agents,
        statusTracker,
        { subscribe: subscribeSessions, state: paneSessionState },
      );
      achievementNotifier ??= createAchievementNotifier({
        loadNotified: loadNotifiedAchievements,
        saveNotified: saveNotifiedAchievements,
        settingsReady: initSettings,
        notify,
        history: {
          getSnapshot: getUsageHistorySnapshot,
          subscribe: subscribeUsageHistory,
        },
      });
      exhaustionNotifier ??= createWindowExhaustionNotifier({
        settingsReady: initSettings,
        notify,
        journal: {
          getSnapshot: windowReportJournal.getSnapshot,
          subscribe: windowReportJournal.subscribe,
        },
        usage: { getSnapshot: usageManager.getSnapshot },
      });
      windowReportJournal.start();
      application.start();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      application.dispose();
      paneInputFocus.dispose();
      exhaustionNotifier?.dispose();
      windowReportJournal.dispose();
      achievementNotifier?.dispose();
      usageChannel?.dispose();
      statusChannel?.dispose();
      pluginDeckBridge.dispose();
      worktreeSweeper.dispose();
      minimizePolicy.dispose();
      mcp.dispose();
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
