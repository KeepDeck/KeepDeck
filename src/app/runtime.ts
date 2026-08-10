import { paneAgentType, panesRunningIn } from "../domain/deck";
import { openPath } from "../ipc/app";
import { log } from "../ipc/log";
import { probeWorktree } from "../ipc/worktree";
import {
  loadNotifiedAchievements,
  saveNotifiedAchievements,
} from "../ipc/achievements";
import { createAchievementNotifier } from "./achievementNotifier";
import { createActivityWitness } from "./activityWitness";
import {
  createAgentOrchestrator,
  type AgentCatalogPort,
} from "./agentOrchestrator";
import { createAgentStatusChannel } from "./agentStatusChannel";
import { createApplicationController } from "./applicationController";
import { createDeckActions } from "./deckActions";
import { createDeckPersistence } from "./deckPersistence";
import { createDeckStore } from "./deckStore";
import {
  DownloadManager,
  tauriDownloadBackend,
  type DownloadBackend,
} from "./downloadManager";
import { createFileOpenManager } from "./fileOpenManager";
import { createJournalPersistence } from "./journalPersistence";
import { commands } from "./commandRegistry";
import {
  createMailService,
  deliverMailThroughPty,
  wakePaneForMail,
} from "./mail";
import { createMcpService } from "./mcp";
import { createPaneIdentity } from "./mcp/paneIdentity";
import { paneIdBySpawnSecret, peekPaneSpawnSpec } from "./spawnSpecs";
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
import { subscribePaneInput } from "./paneInput";
import {
  nudgeBridgePane,
  onBridgeReplyUncollected,
  replyToBridgeHook,
} from "../ipc/status";
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
import { createSkillsLibrary } from "./skillsLibrary";
import { ipcSkillsStorage } from "../ipc/skillsStorage";
import { createWorktreeManager, deckViewOf } from "./worktrees";
import { createWorktreeSweeper } from "./worktreeSweeper";
import { createPaneInputFocusController } from "../presentation/paneInputFocusController";
import { createPaneViewActions } from "../presentation/paneViewActions";

/** Which CLI a pane runs, or null when the deck no longer holds it. */
function paneAgentTypeOf(
  deck: ReturnType<typeof createDeckStore>,
  paneId: string,
): string | null {
  for (const workspace of deck.getSnapshot().workspaces) {
    const pane = workspace.panes.find((candidate) => candidate.id === paneId);
    if (pane) return paneAgentType(pane);
  }
  return null;
}

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
  const deckActions = createDeckActions(deckStore);
  /** How a pane reads, for anything that has to name one. Read per call — a
   * plugin can be installed or removed while the deck is up. */
  const agentLabels = () =>
    plugins.pluginRegistries.agents
      .list()
      .map(({ entry }) => ({ id: entry.id, label: entry.label }));
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
        paneOf: paneIdBySpawnSecret,
        agents: agentLabels,
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
  // Built here, not in `start()`: the streak chip reads it through the
  // runtime the moment the stats dialog mounts, and a witness that started
  // late would have missed the days its two stores already hold.
  const activityWitness = createActivityWitness({
    history: {
      getSnapshot: getUsageHistorySnapshot,
      subscribe: subscribeUsageHistory,
    },
    usage: usageManager,
  });
  const statusTracker = createAgentStatusTracker();
  // Who may speak for a pane. Built before the lanes that ask it, and handed
  // to each as a value, so identity, usage and status cannot drift apart on
  // a question all three have to answer the same way.
  const attribution = createPaneAttribution({
    workspaces: () => deckStore.getSnapshot().workspaces,
    secretOf: (paneId) => peekPaneSpawnSpec(paneId)?.token,
  });
  // Mail exists only while its Experimental toggle is on, so the lifecycle
  // owner looks it up instead of holding it — hence the forward reference.
  const lifecycle = createPaneLifecycle(
    usageManager,
    statusTracker,
    attribution,
    () => mail.current(),
    (paneId) => sessionsBegun.forEach((listener) => listener(paneId)),
  );
  /** Panes whose agent just started a conversation with no memory of the
   * last. A plain fan-out rather than a store: nothing needs the history,
   * only the moment. */
  const sessionsBegun = new Set<(paneId: string) => void>();
  /** The whole mail feature, as one create and one dispose. What it is made
   * of — the queue, the commands, both delivery channels, the reply memory,
   * the standing-presence — composes inside it; these are only the ports it
   * cannot build for itself. */
  const agentEntry = (agentId: string) =>
    plugins.pluginRegistries.agents
      .list()
      .find(({ entry }) => entry.id === agentId)?.entry;
  const mail = createMailService(
    {
      agentTeams: () => getSettings()?.agentTeams ?? null,
      subscribe: subscribeSettings,
    },
    {
      registry: commands,
      deck: {
        workspaces: () => deckStore.getSnapshot().workspaces,
        subscribe: deckStore.subscribe,
        setPaneTeam: (workspaceId, paneId, team) =>
          deckActions.setPaneTeam(workspaceId, paneId, team),
        agentTypeOf: (paneId) => paneAgentTypeOf(deckStore, paneId),
      },
      agents: {
        labels: agentLabels,
        statusOf: (agentId) => agentEntry(agentId)?.status,
        // Through the agent's DECLARED bin, which is the same name the
        // detection pass probed — the join lives with the cache, so nothing
        // out here repeats the walk to `detect.bin`.
        versionOf: plugins.agentBinVersion,
      },
      status: {
        activityOf: (paneId) => statusTracker.getSnapshot().panes.get(paneId),
        subscribe: statusTracker.subscribe,
        onContextRebuilt: statusTracker.onContextRebuilt,
      },
      subscribeChannels: subscribePaneInput,
      onSessionBegan: (listener) => {
        sessionsBegun.add(listener);
        return () => sessionsBegun.delete(listener);
      },
      terminal: { deliver: deliverMailThroughPty, wake: wakePaneForMail },
      bridge: {
        reply: replyToBridgeHook,
        nudge: nudgeBridgePane,
        onReplyUncollected: onBridgeReplyUncollected,
      },
    },
  );
  const windowReportJournal = createAppWindowReportJournal(usageManager);
  const worktrees = createWorktreeManager(
    deckViewOf(() => deckStore.getSnapshot().workspaces),
  );
  // The library takes only the staleness half of the worktree manager: a write
  // has to drop the staged views the next pane spawn would inject.
  const skills = createSkillsLibrary({
    storage: ipcSkillsStorage,
    staging: worktrees,
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
    mcpAccess: (target) => mcp.access(target),
    lifecycle,
  });
  const application = createApplicationController({
    deck: deckStore,
    plugins,
    orchestrator,
    paneInputFocus,
    paneView: paneViewActions,
    skills,
    activityOf: (paneId) => statusTracker.getSnapshot().panes.get(paneId),
  });
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
    skills,
    application,
    paneInputFocus,
    paneViewActions,
    mcp,
    mail,
    usageManager,
    activityWitness,
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
        mail.answerAsk,
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
      activityWitness.dispose();
      exhaustionNotifier?.dispose();
      windowReportJournal.dispose();
      achievementNotifier?.dispose();
      usageChannel?.dispose();
      statusChannel?.dispose();
      pluginDeckBridge.dispose();
      worktreeSweeper.dispose();
      minimizePolicy.dispose();
      mail.dispose();
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
