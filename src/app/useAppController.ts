import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { isStatsTab, type StatsTab } from "../domain/usage/statsTabs";
import { useAgentDialog } from "./useAgentDialog";
import { useAgentRunView } from "./useAgentRunView";
import { useAgents } from "./useAgents";
import { useAppRuntime } from "./runtimeContext";
import { useCloseFlow } from "./useCloseFlow";
import { useContributions, useInstalledPlugins, unavailableAgentReasons } from "../plugins";
import { useDeck } from "./useDeck";
import { useDragDrop } from "./useDragDrop";
import { useGitHead } from "./useGitHead";
import { useMenuHotkeys } from "./useMenuHotkeys";
import { useMinimizeMode } from "./useMinimizeMode";
import { setSourceVisibilityProbe } from "./notificationCenter";
import { workspaceForNotification } from "./notificationNavigation";
import { useNotifications } from "./useNotifications";
import { usePaneDrag } from "./usePaneDrag";
import { usePersistence } from "./usePersistence";
import { useSessionsBrowser } from "./useSessionsBrowser";
import { useSettings } from "./useSettings";
import { useSpawnContext } from "./useSpawnContext";
import { suspendRefusalText } from "./suspendOutcome";
import { useUpdate } from "./useUpdate";
import { buildDockTabs } from "../components/dock/useDockTabs";
import type { SessionHandle } from "../domain/journal";
import { unreadByWorkspace } from "../domain/notifications";
import { DEFAULT_SETTINGS } from "../domain/settings";
import {
  closeHotkeyTarget,
  findWorkspace,
  MAX_PANES,
  maximizeHotkeyTarget,
  paneAgentType,
  paneHasProcess,
  paneHotkeyTarget,
  paneOnScreen,
  resolveSelectedPaneId,
} from "../domain/deck";
import { fetchAppInfo, type AppInfo } from "../ipc/app";
import { describeError, log } from "../ipc/log";
import { pluginCrashes, subscribePluginCrashes } from "./pluginHealth";

/** Shell/application wiring kept separate from the rendered app tree. */
export function useAppController() {
  const runtime = useAppRuntime();
  const { pluginRegistries, pluginHost } =
    runtime.plugins;
  const [info, setInfo] = useState<AppInfo | null>(null);
  const updateState = useUpdate();
  useEffect(() => {
    fetchAppInfo()
      .then(setInfo)
      .catch((e) => {
        log.warn("web:app", `app_info failed: ${describeError(e)}`);
        setInfo(null);
      });
  }, []);
  const deck = useDeck(runtime.deckStore);
  const { agents, loading: agentsLoading } = useAgents();
  const installedPlugins = useInstalledPlugins(pluginHost);
  const unavailableReasons = useMemo(
    () => unavailableAgentReasons(installedPlugins),
    [installedPlugins],
  );
  const settings = useSettings();
  const deckLayout = settings?.deckLayout ?? DEFAULT_SETTINGS.deckLayout;
  const minimizeStyle = settings?.minimizeStyle ?? DEFAULT_SETTINGS.minimizeStyle;
  const dockMode = settings?.dockMode ?? DEFAULT_SETTINGS.dockMode;
  const minimizeOn = useMinimizeMode(deckLayout, minimizeStyle);
  const { restoring, frozen } = usePersistence(runtime.deckPersistence);
  const [frozenAck, setFrozenAck] = useState(false);
  const spawnCtx = useSpawnContext(runtime.spawnContext);
  const orchestrator = runtime.orchestrator;
  const runView = useAgentRunView(orchestrator);
  const sessionsBrowser = useSessionsBrowser();
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
        if (!paneHasProcess(pane)) continue;
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>();
  const [statsTab, setStatsTab] = useState<StatsTab>("overview");
  const agentFlow = useAgentDialog(deck, agents, {
    onResumeFailed: (message) =>
      pushAlert("Could not resume the session", message),
    onForkFailed: (message) => pushAlert("Could not fork the session", message),
    onCreateFailed: (message) => pushAlert("Could not add the agent", message),
  }, runView.blocked);
  const closeFlow = useCloseFlow(deck, {
    onError: (message) => pushAlert("Worktree error", message),
    onSuspendRefused: (message) =>
      pushAlert("Can't suspend this agent", message),
    gitPositions: gitHeads,
    blockedPanes: runView.blocked,
    suspendAgent: orchestrator.suspend,
    closeAgents: orchestrator.close,
  });
  const transactions = [
    agentFlow.dialog,
    closeFlow.closing,
    forkDialog,
    error,
    frozen && !frozenAck ? frozen : null,
  ];
  const dialogOpen = transactions.some((t) => t !== null);
  const canOpenDialog =
    !dialogOpen && !settingsOpen && !statsOpen && !skillsOpen;

  /** THE owner of the Stats open/close/tab sequence — every entry point
   * (toolbar, popover footer, notification deep link, future command) goes
   * through here, so the tab can never go stale and a deep link arriving
   * while the dialog is already open switches tabs instead of being
   * swallowed. */
  const openStats = (tab?: StatsTab | null): boolean => {
    const next = isStatsTab(tab) ? tab : undefined;
    if (statsOpen) {
      if (next !== undefined) setStatsTab(next);
      return true;
    }
    if (!canOpenDialog) return false;
    setStatsTab(next ?? "overview");
    setStatsOpen(true);
    return true;
  };
  const closeStats = () => {
    setStatsOpen(false);
    setStatsTab("overview");
  };
  const applicationUi = useRef({
    agents,
    canOpenDialog,
    openStats,
    pushAlert,
    requestCloseAgent: closeFlow.requestCloseAgent,
    setCreating,
    setSettingsOpen,
    setSettingsSection,
  });
  applicationUi.current = {
    agents,
    canOpenDialog,
    openStats,
    pushAlert,
    requestCloseAgent: closeFlow.requestCloseAgent,
    setCreating,
    setSettingsOpen,
    setSettingsSection,
  };
  useEffect(() => {
    const current = () => applicationUi.current;
    return runtime.application.bindUi({
      agents: () => current().agents,
      requestCloseAgent: (wsId, paneId, label) =>
        current().requestCloseAgent(wsId, paneId, label),
      openSettings: (sectionId) => {
        if (!current().canOpenDialog) return false;
        current().setSettingsSection(sectionId ?? undefined);
        current().setSettingsOpen(true);
        return true;
      },
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
  const selectedPaneId =
    (active &&
      resolveSelectedPaneId(
        active.panes,
        activeView,
        deckLayout,
        minimizeOn,
      )) ??
    null;
  const dockTabs = buildDockTabs({
    contributions: pluginDockTabs,
    crashes,
    workspace: active,
    selectedPaneId,
    open: dockOpen,
  });
  const dockCovers = dockMode === "floating" && dockTabs.length > 0 && !!active;
  const activeCount = active?.panes.length ?? 0;
  const atCap = activeCount >= MAX_PANES;
  const modalOpen =
    showForm || dialogOpen || settingsOpen || statsOpen || skillsOpen;
  const canAddAgent = !!active && !atCap && !modalOpen;
  const visibilityRef = useRef({
    activeId: deck.activeId,
    workspaces: deck.workspaces,
    viewByWs: deck.viewByWs,
    deckLayout,
    minimizeOn,
    modalOpen,
    dockCovers,
    statsOpen,
    statsTab,
  });
  visibilityRef.current = {
    activeId: deck.activeId,
    workspaces: deck.workspaces,
    viewByWs: deck.viewByWs,
    deckLayout,
    minimizeOn,
    modalOpen,
    dockCovers,
    statsOpen,
    statsTab,
  };
  useEffect(() => {
    setSourceVisibilityProbe((source) => {
      if (source.type === "stats") {
        // The Stats dialog counts as "on screen" for its own deep links —
        // no OS banner while the user is looking at the tab that just lit up.
        const now = visibilityRef.current;
        return (
          now.statsOpen && (source.tab === undefined || now.statsTab === source.tab)
        );
      }
      if (source.type !== "pane") return false;
      const now = visibilityRef.current;
      if (now.modalOpen || now.dockCovers || source.workspace.id !== now.activeId) {
        return false;
      }
      const ws = workspaceForNotification(now.workspaces, source.workspace);
      if (!ws) return false;
      return paneOnScreen(
        ws.panes,
        now.viewByWs[source.workspace.id],
        now.deckLayout,
        now.minimizeOn,
        source.paneId,
      );
    });
    return () => setSourceVisibilityProbe(null);
  }, []);
  useMenuHotkeys({
    newWorkspace: () => {
      if (modalOpen) return;
      setCreating(true);
    },
    newAgent: () => {
      if (!canAddAgent) return;
      void agentFlow.openFor(active);
    },
    closeAgent: () => {
      if (modalOpen) return;
      const target = closeHotkeyTarget(
        deck.workspaces,
        deck.activeId,
        deck.viewByWs,
        agents,
        minimizeOn,
      );
      if (!target) return;
      if (target.kind === "workspace")
        closeFlow.requestCloseWorkspace(target.wsId);
      else
        closeFlow.requestCloseAgent(target.wsId, target.paneId, target.label);
    },
    suspendAgent: () => {
      if (modalOpen) return;
      const target = paneHotkeyTarget(
        deck.workspaces,
        deck.activeId,
        deck.viewByWs,
        agents,
        minimizeOn,
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
      if (modalOpen) return;
      if (deckLayout === "list") return;
      const target = maximizeHotkeyTarget(
        deck.workspaces,
        deck.activeId,
        deck.viewByWs,
        minimizeOn,
      );
      if (target) deck.toggleFocus(target.wsId, target.paneId);
    },
    openSettings: () => {
      if (!canOpenDialog) return;
      setSettingsSection(undefined);
      setSettingsOpen(true);
    },
  });
  const handleSelectWorkspace = (id: string) => {
    runtime.application.selectWorkspace(id);
  };
  const notifications = useNotifications();
  const unreadForWs = unreadByWorkspace(notifications);
  const notificationPrefs =
    settings?.notifications ?? DEFAULT_SETTINGS.notifications;
  const showBell =
    notificationPrefs.enabled && notificationPrefs.mode !== "system";
  const openNotification = runtime.application.openNotification;
  const handleCreateWorkspace = runtime.application.createWorkspace;
  const railWorkspaces = deck.workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    agentCount: w.panes.length,
    unread: showBell ? (unreadForWs.get(w.instance) ?? 0) : 0,
  }));
  if (restoring || !spawnCtx || !settings) {
    return { ready: false as const };
  }
  return {
    ready: true as const,
    active,
    activeCount,
    activeView,
    agentFlow,
    agents,
    agentsLoading,
    alertSeq,
    atCap,
    canAddAgent,
    canOpenDialog,
    closeFlow,
    deck,
    deckLayout,
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
    minimizeStyle,
    openNotification,
    orchestrator,
    pluginDockTabs,
    pluginTopBarActions,
    pushAlert,
    railCollapsed,
    railWorkspaces,
    runView,
    sessionsBrowser,
    setCreating,
    setForkDialog,
    setFrozenAck,
    setRailCollapsed,
    setSettingsOpen,
    setSettingsSection,
    setSkillsOpen,
    openStats,
    closeStats,
    selectStatsTab: setStatsTab,
    settings,
    settingsOpen,
    settingsSection,
    showBell,
    showForm,
    skillsOpen,
    specByPane,
    statsOpen,
    statsTab,
    unavailableReasons,
    updateState,
    usageLiveAgents,
    selectedPaneId,
  };
}
