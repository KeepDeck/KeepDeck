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
import { createMailService, wakePaneForMail } from "./mail";
import { createMcpService } from "./mcp";
import { createPaneIdentity } from "./mcp/paneIdentity";
import { paneIdBySpawnSecret, peekPaneSpawnSpec } from "./spawnSpecs";
import { createArtifactsPolicy } from "./artifacts/policy";
import { registerArtifactCommands } from "./artifacts/artifactCommands";
import { artifactChanges } from "./artifacts/changes";
import { artifactsEnableStatus } from "./artifacts/enableStatus";
import { announceArtifact } from "./artifacts/producers";
import { artifactsDisable, artifactsEnable, artifactDropWorkspace } from "../ipc/artifacts";
import { createPaneAttribution } from "./paneAttribution";
import { createMinimizePolicy } from "./minimizePolicy";
import { createPluginDeckBridge } from "./pluginDeckBridge";
import { createPluginManager } from "./pluginManager";
import {
  acquirePane,
  closePane,
  isPaneLaunched,
  paneSessionState,
  subscribeSessions,
} from "./ptyManager";
import { subscribePaneKeys } from "./paneKeys";
import { subscribePaneInput } from "./paneInput";
import {
  nudgeBridgePane,
  replyToBridgeHook,
} from "../ipc/status";
import { createSessionBinding } from "./sessionBinding";
import { notify } from "./notificationCenter";
import { createAgentStatusTracker } from "./agentStatusTracker";
import { createSessionIndexManager } from "./sessionIndexManager";
import { createPaneLifecycle } from "./paneLifecycle";
import { subscribeRoleCatalogChanges } from "./roleCatalogManager";
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
import { skillRefusals } from "./skillRefusals";
import { createSkillsLibrary } from "./skillsLibrary";
import { ipcSkillsStorage } from "../ipc/skillsStorage";
import { createWorktreeManager, deckViewOf } from "./worktrees";
import {
  createMcpPlanting,
  createSkillsStaging,
  createWorktreePlantings,
} from "./worktreePlantings";
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
  // Fleet artifacts: the enable policy (store + display server ride the
  // one Rust pair) and the command registration, gated on BOTH edges —
  // the artifacts setting AND the CONFIRMED mcp socket (the registry IS
  // the MCP projection; the tools exist only while both hold). The
  // disposer pattern makes re-registration idempotent on either edge.
  // The enable's settled state: `null` = unknown/unsettled, `true` =
  // confirmed by the backend, `false` = the last transition FAILED
  // (contention, fault). The registration gate consumes this — a failed
  // enable must RETRACT the tools even while the setting reads On,
  // or the toggle advertises artifact tools that every call refuses.
  let artifactsEnableOk: boolean | null = null;
  const artifactsPolicy = createArtifactsPolicy(
    {
      artifacts: () => getSettings()?.artifacts ?? null,
      subscribe: subscribeSettings,
    },
    { enable: artifactsEnable, disable: artifactsDisable },
    (transition) => {
      // A failed transition MUST be visible somewhere, and each half of
      // that has ONE owner: the policy logs the failed call (it is the
      // one that made it), the gate retraction below is the behavior,
      // and the status keeps the REASON — the only copy of it, since the
      // store itself knows nothing but that it is closed. Logging here
      // as well printed every backend refusal twice, in the same words.
      artifactsEnableOk = transition.ok;
      artifactsEnableStatus.record(transition);
      // Every claim flip changes the bundled skills staging gate — the
      // tier's arming follows the claim, and the staging memo only
      // invalidates on skill writes, so without this a flip leaves panes
      // spawned after it on the PRE-flip views. TDZ-safe: report fires
      // only from the policy's chain microtasks and createAppRuntime is
      // synchronous — `worktrees` (bound later) exists before any report
      // can run. Bare invalidate is verified sufficient: a cleared memo
      // is a miss, the miss re-runs stageSkills.
      worktrees.invalidateSkills();
      reconcileArtifactCommands();
    },
  );
  let disposeArtifactCommands: (() => void) | null = null;
  const reconcileArtifactCommands = () => {
    const shouldRun =
      (getSettings()?.artifacts ?? false) &&
      artifactsEnableOk === true &&
      mcp.status().socket !== null;
    if (shouldRun && disposeArtifactCommands === null) {
      disposeArtifactCommands = registerArtifactCommands(
        commands,
        {
          deck: () => deckStore.getSnapshot(),
          announce: (event) =>
            announceArtifact(event, {
              workspaces: () => deckStore.getSnapshot().workspaces,
            }),
          changed: () => artifactChanges.changed(),
        },
      );
    } else if (!shouldRun && disposeArtifactCommands !== null) {
      disposeArtifactCommands();
      disposeArtifactCommands = null;
    }
  };
  const stopArtifactWiring = [
    subscribeSettings(reconcileArtifactCommands),
    mcp.subscribe(reconcileArtifactCommands),
  ];
  reconcileArtifactCommands();
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
  // The session-search index's freshness owner — needs are declared by
  // surfaces (browser, spawn picker), when to scan is decided here.
  const sessionIndex = createSessionIndexManager(
    plugins.pluginRegistries.agents,
  );
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
        // Through the agent's DECLARED bin. The walk from an agent id to
        // that bin lives in one place (`binOfAgent`), so nothing out here
        // repeats it.
        versionOf: plugins.agentBinVersion,
        onAgentsChanged: plugins.pluginRegistries.agents.subscribe,
        // Fire and forget: the port answers from its own cache — which a
        // re-detection drops, so a repeat is how a forgotten version is
        // learned again — and nothing in the render path may wait on a
        // process starting. The
        // catch is what makes "cannot be awaited" true rather than merely
        // intended — a discarded promise that rejects is an unhandled one.
        learnVersion: (agentId) => {
          void plugins.ensureAgentVersion(agentId).catch(() => {});
        },
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
      // CHANGES only, never the boot load: an app start installs the same
      // catalog the panes were last briefed from, and re-stating it would
      // hand every teamed pane an unsolicited briefing per launch.
      onRoleCatalogChanged: subscribeRoleCatalogChanges,
      terminal: { wake: wakePaneForMail },
      bridge: { reply: replyToBridgeHook, nudge: nudgeBridgePane },
    },
  );
  // Where an arming pass's refusals land for the skills surface to read.
  // A standing condition, not an event: republished on every pass, so the
  // list ends the moment the user's own file moves out of the way.
  const windowReportJournal = createAppWindowReportJournal(usageManager);
  const worktrees = createWorktreeManager(
    deckViewOf(() => deckStore.getSnapshot().workspaces),
    (deck, inOrder) =>
      createWorktreePlantings(deck, inOrder, {
        skills: (deck, inOrder) =>
          createSkillsStaging(deck, inOrder, skillRefusals.publish),
        mcp: createMcpPlanting,
      }),
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
      isLaunched: isPaneLaunched,
      acquire: acquirePane,
      close: closePane,
    },
    plugins,
    probe: probeWorktree,
    worktrees,
    mcpAccess: (target) => mcp.access(target),
    lifecycle,
    // Workspace deletion drops its artifact store — the deck model is the
    // only knower of the live workspace set (Rust cannot derive it).
    dropArtifacts: (wsId) => artifactDropWorkspace(wsId),
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
    sessionIndex,
    windowReportJournal,
    start() {
      if (disposed) return;
      // The binding lane first, and the usage channel over it: the tails lane
      // follows the bindings this one ACCEPTED rather than judging the same
      // event a second time. The verdict pins a generation to a process, so
      // asking it twice would tell the second asker the first had bound.
      if (sessionBinding === null) {
        sessionBinding = createSessionBinding(deckStore, lifecycle, attribution);
        // A binding is the app learning that a session now EXISTS, so the
        // index's last walk is behind its store from this moment. Widely,
        // not per agent: the accepted binding does not carry one, and a
        // needless extra sweep is the cheap side of this trade.
        sessionBinding.subscribe(() => sessionIndex.invalidate());
      }
      const bindings = sessionBinding;
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
        mail.expectAsk,
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
      sessionIndex.dispose();
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
      disposeArtifactCommands?.();
      for (const stop of stopArtifactWiring) stop();
      // NO final disable: this runs from `beforeunload`, which fires on
      // every window reload — the display server outlives the page and
      // dies with the process.
      artifactsPolicy.dispose();
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
