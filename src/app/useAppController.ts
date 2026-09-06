import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useAgentDialog } from "./useAgentDialog";
import { useAgentRunView } from "./useAgentRunView";
import { useAgents } from "./useAgents";
import { useAppRuntime } from "./runtimeContext";
import { askBackgroundCarriers } from "./liveSessions";
import { useCloseFlow } from "./useCloseFlow";
import { useContributions, useInstalledPlugins, unavailableAgentReasons } from "../plugins";
import { useDeck } from "./useDeck";
import { useDragDrop } from "./useDragDrop";
import { useGitHead } from "./useGitHead";
import { useMenuHotkeys } from "./useMenuHotkeys";
import { useModalRouter } from "./useModalRouter";
import { setSourceVisibilityProbe } from "./notificationCenter";
import { useActivityNotifications } from "./useActivityNotifications";
import { useWorkspaceFrames } from "./useWorkspaceFrames";
import { workspaceForNotification } from "./notificationNavigation";
import { usePaneDrag } from "./usePaneDrag";
import { usePersistence } from "./usePersistence";
import { useBrowserSharedSeam } from "./useSessionsBrowser";
import { useSettings } from "./useSettings";
import { useSpawnContext } from "./useSpawnContext";
import { suspendRefusalText } from "./suspendOutcome";
import { useUpdate } from "./useUpdate";
import { buildDockTabs } from "../components/dock/useDockTabs";
import type { SessionHandle } from "../domain/journal";
import { DEFAULT_SETTINGS } from "../domain/settings";
import { artifactsDoorOpen } from "./artifacts/door";
import {
  closeHotkeyTarget,
  findWorkspace,
  MAX_PANES,
  maximizeHotkeyTarget,
  paneAgentType,
  paneHasProcess,
  paneHotkeyTarget,
  membersOf,
  openTeamOf,
  paneInFront,
  resolveSelectedPaneId,
  stagePanes,
  teamHeldPath,
} from "../domain/deck";
import type { AppInfo } from "../ipc/app";
import { readAppInfo } from "./appInfo";
import { layering, statsDeepLinkOnScreen } from "../presentation/layering";
import { describeError, log } from "../ipc/log";
import { pluginCrashes, subscribePluginCrashes } from "./pluginHealth";
import { addTeamDoorOpen, bellDoorOpen, dockDoorOpen } from "./doors";
import type { BarLevel } from "../components/deck/DeckBar";
import { teamBranchOf } from "../presentation/teamCardView";

/** Shell/application wiring kept separate from the rendered app tree. */
export function useAppController() {
  const runtime = useAppRuntime();
  const { pluginRegistries, pluginHost } =
    runtime.plugins;
  const [info, setInfo] = useState<AppInfo | null>(null);
  const updateState = useUpdate();
  useEffect(() => {
    readAppInfo()
      .then(setInfo)
      .catch((e) => {
        log.warn("web:app", `app_info failed: ${describeError(e)}`);
        setInfo(null);
      });
  }, []);
  const deck = useDeck(runtime.deckStore);
  const paneViewActions = runtime.paneViewActions;
  const { agents, loading: agentsLoading } = useAgents();
  const installedPlugins = useInstalledPlugins(pluginHost);
  const unavailableReasons = useMemo(
    () => unavailableAgentReasons(installedPlugins),
    [installedPlugins],
  );
  const settings = useSettings();
  const dockMode = settings?.dockMode ?? DEFAULT_SETTINGS.dockMode;
  const { restoring, frozen } = usePersistence(runtime.deckPersistence);
  const [frozenAck, setFrozenAck] = useState(false);
  const spawnCtx = useSpawnContext(runtime.spawnContext);
  const orchestrator = runtime.orchestrator;
  const runView = useAgentRunView(orchestrator);
  const browserShared = useBrowserSharedSeam();
  const [forkDialog, setForkDialog] = useState<{
    wsId: string;
    record: SessionHandle;
  } | null>(null);
  const specByPane = runView.specs;
  const failedPanes = runView.planFailed;
  const usageLiveAgents = useMemo(() => {
    const ids = new Set<string>();
    for (const ws of deck.workspaces) {
      for (const pane of ws.panes) {
        if (!paneHasProcess(ws, pane)) continue;
        ids.add(paneAgentType(pane));
      }
    }
    return ids;
  }, [deck.workspaces]);
  const gitHeads = useGitHead(deck);
  const [creating, setCreating] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [alerts, setAlerts] = useState<{ title: string; message: string }[]>([]);
  const error = alerts[0] ?? null;
  const [alertSeq, setAlertSeq] = useState(0);
  const pushAlert = (title: string, message: string) =>
    setAlerts((queue) => [...queue, { title, message }]);
  const dismissAlert = () => {
    setAlerts((queue) => queue.slice(1));
    setAlertSeq((n) => n + 1);
  };
  const agentFlow = useAgentDialog(deck, agents, {
    onResumeFailed: (message) =>
      pushAlert("Could not resume the session", message),
    onForkFailed: (message) => pushAlert("Could not fork the session", message),
    onCreateFailed: (message) => pushAlert("Could not add the agent", message),
    onTeamFailed: (message) => pushAlert("Could not start the team", message),
  }, runView.blocked);
  const closeFlow = useCloseFlow(deck, {
    onError: (message) => pushAlert("Worktree error", message),
    onSuspendRefused: (message) =>
      pushAlert("Can't suspend this agent", message),
    gitPositions: gitHeads,
    blockedPanes: runView.blocked,
    suspendAgent: orchestrator.suspend,
    closeAgents: orchestrator.close,
    // The registry ask the close sentence needs — batched (one query per
    // distinct agent), the same seam every live-session question goes
    // through, so the view layer never touches a plugin.
    backgroundCarriers: (entries) =>
      askBackgroundCarriers({ pluginHost, pluginRegistries }, entries),
  });
  const transactions = [
    agentFlow.dialog,
    closeFlow.closing,
    forkDialog,
    error,
    frozen && !frozenAck ? frozen : null,
  ];
  const dialogOpen = transactions.some((t) => t !== null);
  /** The dialog layer (settings / statistics / skills) has one owner: its
   * flags, gate and open/close/retarget verbs all live in the router. */
  const modal = useModalRouter({ transactionOpen: dialogOpen });
  const canOpenDialog = modal.canOpenDialog;
  const applicationUi = useRef({
    agents,
    openSettings: modal.openSettings,
    openStats: modal.openStats,
    pushAlert,
    requestCloseAgent: closeFlow.requestCloseAgent,
    setCreating,
  });
  applicationUi.current = {
    agents,
    openSettings: modal.openSettings,
    openStats: modal.openStats,
    pushAlert,
    requestCloseAgent: closeFlow.requestCloseAgent,
    setCreating,
  };
  useEffect(() => {
    const current = () => applicationUi.current;
    return runtime.application.bindUi({
      agents: () => current().agents,
      requestCloseAgent: (wsId, paneId, label) =>
        current().requestCloseAgent(wsId, paneId, label),
      openSettings: (sectionId) =>
        current().openSettings(sectionId ?? undefined),
      openUsage: (tab) => current().openStats(tab),
      setCreating: (next) => current().setCreating(next),
      pushAlert: (title, message) => current().pushAlert(title, message),
    });
  }, [runtime.application]);
  const pluginDockTabs = useContributions(pluginRegistries.dockTabs);
  const pluginTopBarActions = useContributions(pluginRegistries.topBarActions);
  const crashes = useSyncExternalStore(subscribePluginCrashes, pluginCrashes);
  const focusDroppedPane = (paneId: string) =>
    deck.selectPane(deck.activeId, paneId);
  useDragDrop(focusDroppedPane);
  usePaneDrag(focusDroppedPane);
  const active = findWorkspace(deck.workspaces, deck.activeId) ?? null;
  const activeView = deck.viewOf(deck.activeId);
  const dockOpen = activeView.dock ?? false;
  const showForm = creating || deck.workspaces.length === 0;
  // Resolved over the stage's slice: a highlight is only ever on a pane of
  // the open team, and at the cards level there is none.
  const selectedPaneId =
    (active && resolveSelectedPaneId(stagePanes(active, activeView), activeView)) ?? null;
  const dockTabs = buildDockTabs({
    contributions: pluginDockTabs,
    crashes,
    workspace: active,
    selectedPaneId,
    open: dockOpen,
  });
  const activeCount = active?.panes.length ?? 0;
  // The stage's level: the team in front of the person, or the cards. The
  // cap is the TEAM's — the grid its members lay out on.
  const openTeam = active ? openTeamOf(active, activeView) : undefined;
  const teamCount = active && openTeam ? membersOf(active, openTeam.id).length : 0;
  const atCap = teamCount >= MAX_PANES;
  // What is painted over what — decided once, in `layering`, for the render
  // and for the notification probe alike. The z-order reasoning lives there.
  const windows = layering({
    creating,
    workspaceCount: deck.workspaces.length,
    dialogOpen,
    anyDialogOpen: modal.anyDialogOpen,
    statsOpen: modal.statsOpen,
    statsTab: modal.statsTab,
    dockMode,
    dockTabs: dockTabs.length,
    hasActive: !!active,
  });
  const canAddMember = !!openTeam && !atCap && !windows.modal;
  const canAddTeam = !!active && addTeamDoorOpen(active) && !windows.modal;
  // The probe reads the LAST RENDER's decision, not a copy of its inputs:
  // `windows` rides the ref whole, so a layer the render learns about is a
  // layer the probe knows about, with nothing to keep in step by hand.
  const visibilityRef = useRef({
    activeId: deck.activeId,
    workspaces: deck.workspaces,
    viewByWs: deck.viewByWs,
    windows,
  });
  visibilityRef.current = {
    activeId: deck.activeId,
    workspaces: deck.workspaces,
    viewByWs: deck.viewByWs,
    windows,
  };
  useEffect(() => {
    setSourceVisibilityProbe((source) => {
      if (source.type === "stats") {
        // The Stats dialog counts as "on screen" for its own deep links —
        // no OS banner while the user is looking at the tab that just lit
        // up — unless a confirm dialog is painted over it.
        return statsDeepLinkOnScreen(visibilityRef.current.windows.stats, source.tab);
      }
      if (source.type !== "pane") return false;
      const now = visibilityRef.current;
      if (
        now.windows.modal ||
        now.windows.dockCovers ||
        source.workspace.id !== now.activeId
      ) {
        return false;
      }
      const ws = workspaceForNotification(now.workspaces, source.workspace);
      if (!ws) return false;
      // On screen = the workspace is active AND its team is the open one AND
      // the pane is on that team's grid: the slice is empty for a team that
      // is not open, so a pane there is never "in front of the person".
      return paneInFront(ws, now.viewByWs[source.workspace.id], source.paneId);
    });
    return () => setSourceVisibilityProbe(null);
  }, []);
  // Announce the transitions worth leaving the app for: needs-you, finished,
  // failed.
  useActivityNotifications(deck.workspaces, agents);
  // Each workspace's status folded to one frame for its rail dot.
  const railFrames = useWorkspaceFrames(deck.workspaces, deck.activeId);
  useMenuHotkeys({
    newWorkspace: () => {
      if (windows.modal) return;
      setCreating(true);
    },
    newAgent: () => {
      // The level decides what "new" means: a member inside a team, a team
      // at the cards — the same two doors the bar offers.
      if (!active) return;
      if (openTeam) {
        if (canAddMember) void agentFlow.openFor(active, { kind: "member", teamId: openTeam.id });
      } else if (canAddTeam) {
        void agentFlow.openFor(active, { kind: "new-team" });
      }
    },
    closeAgent: () => {
      if (windows.modal) return;
      const target = closeHotkeyTarget(
        deck.workspaces,
        deck.activeId,
        deck.viewByWs,
        agents,
      );
      if (!target) return;
      if (target.kind === "workspace")
        closeFlow.requestCloseWorkspace(target.wsId);
      else
        closeFlow.requestCloseAgent(target.wsId, target.paneId, target.label);
    },
    suspendAgent: () => {
      if (windows.modal) return;
      const target = paneHotkeyTarget(
        deck.workspaces,
        deck.activeId,
        deck.viewByWs,
        agents,
      );
      if (!target) return;
      void orchestrator.suspend(target.wsId, target.paneId).then((outcome) => {
        if (outcome === "suspended") return;
        pushAlert(
          "Can't suspend this agent",
          suspendRefusalText(outcome, target.label),
        );
      });
    },
    toggleMaximize: () => {
      if (windows.modal) return;
      const target = maximizeHotkeyTarget(
        deck.workspaces,
        deck.activeId,
        deck.viewByWs,
      );
      if (target) paneViewActions.toggleMaximize(target.wsId, target.paneId);
    },
    openSettings: () => void modal.openSettings(),
  });
  const handleSelectWorkspace = (id: string) => {
    runtime.application.selectWorkspace(id);
  };
  const notificationPrefs =
    settings?.notifications ?? DEFAULT_SETTINGS.notifications;
  const showBell = bellDoorOpen(notificationPrefs);
  const openNotification = runtime.application.openNotification;
  const handleCreateWorkspace = runtime.application.createWorkspace;
  const railWorkspaces = deck.workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    agentCount: w.panes.length,
    dot: railFrames.get(w.id) ?? ("none" as const),
  }));
  if (restoring || !spawnCtx || !settings) {
    return { ready: false as const };
  }
  /** The bar's level, composed HERE like every other door: whether a
   * control exists is a policy about the app's state, and the bar's whole
   * say in it is a null check. */
  const barLevel: BarLevel =
    active && openTeam
      ? {
          kind: "team",
          name: openTeam.name,
          branch: teamBranchOf(openTeam, gitHeads.get(teamHeldPath(openTeam) ?? active.cwd)),
          onBack: () => deck.closeTeam(active.id),
          canAddMember,
          addMemberTitle: atCap ? `Max ${MAX_PANES} agents on a team` : "Add a member",
          onAddMember: () => {
            if (canAddMember) void agentFlow.openFor(active, { kind: "member", teamId: openTeam.id });
          },
        }
      : {
          kind: "teams",
          onAddTeam:
            active && canAddTeam ? () => void agentFlow.openFor(active, { kind: "new-team" }) : null,
        };
  return {
    ready: true as const,
    active,
    activeCount,
    activeView,
    agentFlow,
    agents,
    agentsLoading,
    alertSeq,
    barLevel,
    canOpenDialog,
    closeFlow,
    deck,
    dismissAlert,
    dockMode,
    dockOpen,
    dockTabs,
    error,
    failedPanes,
    forkDialog,
    frozen,
    frozenAck,
    gitHeads,
    handleCreateWorkspace,
    handleSelectWorkspace,
    info,
    openNotification,
    orchestrator,
    paneViewActions,
    pluginDockTabs,
    pluginTopBarActions,
    pushAlert,
    railCollapsed,
    railWorkspaces,
    runView,
    browserShared,
    setCreating,
    setForkDialog,
    setFrozenAck,
    setRailCollapsed,
    canCloseDialog: modal.canCloseDialog,
    openSettings: modal.openSettings,
    closeSettings: modal.closeSettings,
    openSkills: modal.openSkills,
    closeSkills: modal.closeSkills,
    /** Three controls the top bar offers only sometimes, each composed
     * HERE rather than in the markup: whether a control exists is a
     * policy about the app's state — a setting, a live workspace, a
     * plugin's contribution — and the bar's whole say in it is a null
     * check. Each policy is a named door with one home (`doors.ts`, beside
     * the artifacts door), so a hotkey or a command asking the same
     * question asks the same function. */
    openArtifacts: artifactsDoorOpen(settings)
      ? () => void modal.openArtifacts()
      : null,
    dockControl:
      dockDoorOpen(pluginDockTabs.length)
        ? {
            open: dockOpen,
            onToggle: () => active && deck.toggleDock(active.id),
          }
        : null,
    closeArtifacts: modal.closeArtifacts,
    openStats: modal.openStats,
    closeStats: modal.closeStats,
    selectStatsTab: modal.selectStatsTab,
    settings,
    settingsOpen: modal.settingsOpen,
    settingsSection: modal.settingsSection,
    showBell,
    showForm,
    skillsOpen: modal.skillsOpen,
    artifactsOpen: modal.artifactsOpen,
    specByPane,
    statsOpen: modal.statsOpen,
    statsTab: modal.statsTab,
    unavailableReasons,
    updateState,
    usageLiveAgents,
    selectedPaneId,
    keyboardFocusEnabled: windows.panesInteractive,
  };
}
