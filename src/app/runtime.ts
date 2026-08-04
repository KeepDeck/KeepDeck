import { panesRunningIn } from "../domain/deck";
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
import { createMcpService } from "./mcp";
import { createPaneIdentity } from "./mcp/paneIdentity";
import { paneIdByMcpToken, peekPaneSpawnSpec } from "./spawnSpecs";
import { createPaneAttribution } from "./paneAttribution";
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
import { subscribePaneKeys } from "./paneKeys";
import { createSessionBinding } from "./sessionBinding";
import { notify } from "./notificationCenter";
import { createAgentStatusTracker } from "./agentStatusTracker";
import { createPaneLifecycle } from "./paneLifecycle";
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
import { createWorktreeManager, deckViewOf } from "./worktrees";
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
  const mcp = createMcpService(
    {
      mcpServer: () => getSettings()?.mcpServer ?? null,
      subscribe: subscribeSettings,
    },
    {
      panesIn: (cwd) =>
        panesRunningIn(deckStore.getSnapshot().workspaces, cwd),
      // kimi's config lands in a pane's cwd, so the owner of those directories
      // decides when it may. These two exist only to break the construction
      // cycle between the two owners — `worktrees` is built below and neither
      // is called before a spawn, long after.
      plant: (workspaceId, root, content) =>
        worktrees.plantMcp(workspaceId, root, content),
      retract: (roots) => worktrees.retractMcp(roots),
      identify: createPaneIdentity({
        workspaces: () => deckStore.getSnapshot().workspaces,
        paneOf: paneIdByMcpToken,
        agents: () =>
          plugins.pluginRegistries.agents
            .list()
            .map(({ entry }) => ({ id: entry.id, label: entry.label })),
      }),
    },
  );
  const journalPersistence = createJournalPersistence(
    deckStore,
    deckPersistence,
  );
  let sessionBinding: ReturnType<typeof createSessionBinding> | null = null;
  const spawnContext = createSpawnContextSource();
  // The live telemetry stores (usage, activity) and the retire owner over
  // them. Runtime state like the deck store: the orchestrator retires panes
  // and the bridge channels report in with no component mounted.
  const usageManager = createUsageManager();
  const statusTracker = createAgentStatusTracker();
  // Who may speak for a pane. Built before the lanes that ask it, and handed
  // to each as a value, so identity, usage and status cannot drift apart on
  // a question all three have to answer the same way.
  const attribution = createPaneAttribution({
    workspaces: () => deckStore.getSnapshot().workspaces,
    secretOf: (paneId) => peekPaneSpawnSpec(paneId)?.token,
  });
  const lifecycle = createPaneLifecycle(
    usageManager,
    statusTracker,
    attribution,
  );
  const windowReportJournal = createAppWindowReportJournal(usageManager);
  const worktrees = createWorktreeManager(
    deckViewOf(() => deckStore.getSnapshot().workspaces),
  );
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
    mcpAccess: (target) => mcp.access(target),
    lifecycle,
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
    windowReportJournal,
    start() {
      if (disposed) return;
      // The binding lane first, and the usage channel over it: the tails lane
      // follows the bindings this one ACCEPTED rather than judging the same
      // event a second time. The verdict pins a generation to a process, so
      // asking it twice would tell the second asker the first had bound.
      const bindings = (sessionBinding ??= createSessionBinding(
        deckStore,
        lifecycle,
        attribution,
      ));
      usageChannel ??= createUsageChannel(
        deckStore,
        plugins.pluginRegistries.agents,
        usageManager,
        attribution,
        bindings,
      );
      statusChannel ??= createAgentStatusChannel(
        deckStore,
        plugins.pluginRegistries.agents,
        statusTracker,
        { subscribe: subscribeSessions, state: paneSessionState },
        attribution,
        { subscribe: subscribePaneKeys },
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
