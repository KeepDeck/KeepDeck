import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DeckStage } from "./components/DeckStage";
import { WorkspacesRail } from "./components/workspace/WorkspacesRail";
import { WorkspaceForm } from "./components/workspace/WorkspaceForm";
import { AgentDialog } from "./components/workspace/AgentDialog";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { StatsDialog } from "./components/stats/StatsDialog";
import { SkillsDialog } from "./components/skills/SkillsDialog";
import { fetchAppInfo, type AppInfo } from "./ipc/app";
import { isFoundUpdate, restartToUpdate } from "./app/updateManager";
import { useUpdate } from "./app/useUpdate";
import { pickFolder } from "./ipc/dialogs";
import { describeError, log } from "./ipc/log";
import { inspectRepo, listBranches, probeWorktree } from "./ipc/worktree";
import { useAgents } from "./app/useAgents";
import { useDeck } from "./app/useDeck";
import { usePersistence } from "./app/usePersistence";
import { useJournalPersistence } from "./app/useJournalPersistence";
import { useSessionsBrowser } from "./app/useSessionsBrowser";
import { ForkTargetDialog } from "./components/workspace/ForkTargetDialog";
import type { SessionHandle } from "./domain/journal";
import { useSkillsPrune } from "./app/useSkillsPrune";
import { useAgentRunView } from "./app/useAgentRunView";
import { suspendRefusalText } from "./app/suspendOutcome";
import { useSessionBinding } from "./app/useSessionBinding";
import { useUsageChannel } from "./app/useUsageChannel";
import { useSettings } from "./app/useSettings";
import { useMinimizeMode } from "./app/useMinimizeMode";
import { DEFAULT_SETTINGS } from "./domain/settings";
import { useSpawnContext } from "./app/useSpawnContext";
import { useGitHead } from "./app/useGitHead";
import { setSourceVisibilityProbe } from "./app/notificationCenter";
import {
  notifyAgentCrashed,
  notifyAgentSpawnFailed,
} from "./app/notificationProducers";
import { useNotifications } from "./app/useNotifications";
import { NotificationBell } from "./components/notifications/NotificationBell";
import { UsageChips } from "./components/usage/UsageChips";
import { unreadByWorkspace, type Notification } from "./domain/notifications";
import {
  settingsSectionForNotification,
  shouldRevealPluginDock,
  workspaceForNotification,
} from "./app/notificationNavigation";
import { useAgentDialog } from "./app/useAgentDialog";
import { useCloseFlow } from "./app/useCloseFlow";
import { useCoreCommands } from "./app/coreCommands";
import { useAppRuntime } from "./app/runtimeContext";
import { toWorkspaceSnapshot } from "./app/pluginSnapshots";
import { usePluginDeckBridge } from "./app/usePluginDeckBridge";
import { unavailableAgentReasons, useContributions, useInstalledPlugins } from "./plugins";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { externalPluginUrl } from "./plugins/external/url";
import { DockPanel, type DockTabItem } from "./components/dock/DockPanel";
import { PluginFailurePanel } from "./components/dock/PluginFailurePanel";
import { PluginOverlays } from "./components/PluginOverlays";
import {
  pluginCrashes,
  reportPluginCrash,
  subscribePluginCrashes,
} from "./app/pluginHealth";
import { useMenuHotkeys } from "./app/useMenuHotkeys";
import { useDragDrop } from "./app/useDragDrop";
import { usePaneDrag } from "./app/usePaneDrag";
import {
  closeHotkeyTarget,
  DECK_STATE_VERSION,
  findWorkspace,
  MAX_PANES,
  maximizeHotkeyTarget,
  paneAgentType,
  paneHasProcess,
  paneHotkeyTarget,
  paneOnScreen,
  pathOccupancy,
  type SpawnConfig,
} from "./domain/deck";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { ModalOverlay } from "./ui/ModalOverlay";
import "./styles/index.css";

/**
 * The composition root: owns only shell-level UI state (rail collapse, the
 * create form, the error notice) and wires the application hooks — deck state,
 * provisioning, the "+ Agent" dialog, the confirmed-close flow, menu hotkeys
 * and file drops — to the components that render them.
 */
function App() {
  const runtime = useAppRuntime();
  const { bootstrapPlugins, pluginRegistries, revealPluginDockTab, pluginHost } =
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

  // The deck's workspaces + active id + per-workspace maximize/selection, in one
  // reducer so close transitions clean focus + selection atomically ([S1], [B2],
  // [L6]).
  const deck = useDeck(runtime.deckStore);
  // The agent catalog: cli plugins' contributions + install detection.
  const { agents, loading: agentsLoading } = useAgents();
  // Agents whose plugin is enabled but unavailable (CLI not installed) —
  // the pane card names the cause instead of a bare "no plugin provides".
  const installedPlugins = useInstalledPlugins(pluginHost);
  const unavailableReasons = useMemo(
    () => unavailableAgentReasons(installedPlugins),
    [installedPlugins],
  );
  // Global preferences ([F6]) — loaded before the first paint, saved through.
  const settings = useSettings();
  // The deck's display mode and how minimized agents show ([F6]). `minimizeOn`
  // = the stored minimized sets are IN FORCE: only the grid layout renders
  // them, and only when the style isn't "none" — the hotkeys must agree with
  // the screen on what's visible.
  const deckLayout = settings?.deckLayout ?? DEFAULT_SETTINGS.deckLayout;
  const minimizeStyle = settings?.minimizeStyle ?? DEFAULT_SETTINGS.minimizeStyle;
  const minimizeOn = useMinimizeMode(deckLayout, minimizeStyle, deck);
  // Restore the saved deck on boot; save (debounced) on every change ([F7]).
  // `frozen` = the stored deck needs a newer build: session parked, no saves.
  const { restoring, frozen } = usePersistence(deck);
  // journal.jsonl rides the same boot gate: hydrate after the deck restored,
  // freeze alongside a frozen deck (see the hook's ordering contract).
  useJournalPersistence(deck, restoring, frozen !== null);
  // Skills housekeeping: drop dead workspaces' derived skill dirs at boot
  // and on every close. Never while restoring or parked — an unhydrated deck
  // reads as "no workspaces" and would sweep the live dirs too.
  useSkillsPrune(deck.workspaces, !restoring && !frozen);
  const [frozenAck, setFrozenAck] = useState(false);
  // Per-install spawn-plan constants (bridge inbox, reporter activation) — the
  // deck's first paint waits for it ([F7]/[F8] session identity v2).
  const spawnCtx = useSpawnContext(runtime.spawnContext);
  // Wake restored panes lazily per workspace — resuming recorded sessions —
  // and report gone directories ([F7]/[F8]).
  const orchestrator = runtime.orchestrator;
  const runView = useAgentRunView(orchestrator);
  const sessionsBrowser = useSessionsBrowser();
  // The fork-target dialog's subject, when one is open.
  const [forkDialog, setForkDialog] = useState<{
    wsId: string;
    record: SessionHandle;
  } | null>(null);
  // Every live pane's spawn plan comes from the orchestrator, which builds it
  // through the agent plugin's hooks as part of the same reconciliation that
  // decides the pane should run at all.
  const specByPane = runView.specs;
  const failedPanes = runView.planFailed;
  // Record session bindings: assigned ids at spawn, reporter postbacks after.
  useSessionBinding(deck);
  // Wire bridge usage reports into the usage store (single mount) and prune
  // pane usage as panes close; the chips read the store on their own.
  useUsageChannel(deck);
  // Agent ids present in the deck — account-limit-capable ones earn a chip
  // immediately, so the limits roster is stable instead of appearing report
  // by report. Pane-only telemetry never enters the top bar.
  const usageLiveAgents = useMemo(() => {
    const ids = new Set<string>();
    for (const ws of deck.workspaces) {
      for (const pane of ws.panes) {
        // Dormant/provisioning panes have no running process — counting
        // them gave background workspaces eternal "waiting" chips (revive
        // only wakes the active workspace). The same predicate the tail and
        // polling lanes ask, so they cannot answer differently.
        if (!paneHasProcess(pane)) continue;
        ids.add(paneAgentType(pane));
      }
    }
    return ids;
  }, [deck.workspaces]);
  // Runtime git HEAD observations for pane badges and worktree close cleanup.
  const gitHeads = useGitHead(deck);
  // The new-workspace form is open (also shown whenever there are no workspaces).
  const [creating, setCreating] = useState(false);
  // Whether the left Workspaces rail is collapsed.
  const [railCollapsed, setRailCollapsed] = useState(false);
  // In-app error notices (no system dialogs). The title belongs to the
  // caller: worktree cleanup and workspace allocation are separate failure
  // domains.
  //
  // A QUEUE, not a slot. It used to be one slot with "first wins", so a
  // second failure could not replace a notice the user was still reading —
  // right about the reading, wrong about the second failure, which was
  // dropped without a trace. The pair that made that visible: a worktree
  // delete failing asynchronously while the user takes Suspend in another
  // pane's close dialog. Whichever landed first silenced the other, and the
  // suspend refusal is the one with nowhere else to appear — its dialog has
  // already closed and the pane just stayed running.
  const [alerts, setAlerts] = useState<{ title: string; message: string }[]>([]);
  const error = alerts[0] ?? null;
  // Counts dismissals, not alerts: it keys the dialog so each notice mounts
  // its own, rather than the next one's text appearing inside the element the
  // user's finger is already on.
  const [alertSeq, setAlertSeq] = useState(0);
  /** Queue a notice behind whatever the user is reading. */
  const pushAlert = (title: string, message: string) =>
    setAlerts((queue) => [...queue, { title, message }]);
  const dismissAlert = () => {
    setAlerts((queue) => queue.slice(1));
    setAlertSeq((n) => n + 1);
  };
  // The settings dialog ([F6]) — opened from the app menu (⌘,), the gear, or
  // a plugin's `openSettings`. When a plugin opens it, the target section id
  // rides along so the dialog lands on that plugin's page.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Global observational data has its own surface, independent of Settings
  // and of the active workspace's contribution-driven dock.
  const [statsOpen, setStatsOpen] = useState(false);
  // The shared-skills library editor ([skills]) — opened from the top bar.
  const [skillsOpen, setSkillsOpen] = useState(false);
  // Which section the dialog opens on: the gear opens the first section, the
  // top bar's update chip jumps to Updates, and a plugin's `settings.open`
  // command jumps to that plugin's page.
  const [settingsSection, setSettingsSection] = useState<string | undefined>();
  // "+ Agent" dialog — always shown, to pick the agent type (+ name, and the
  // per-agent worktree location, [F2]).
  const agentFlow = useAgentDialog(deck, agents, {
    // The dialog's "Start from" continuations fail the same VISIBLE way the
    // journal rows' Resume/Fork do below.
    onResumeFailed: (message) =>
      pushAlert("Could not resume the session", message),
    onForkFailed: (message) => pushAlert("Could not fork the session", message),
    onCreateFailed: (message) => pushAlert("Could not add the agent", message),
  }, runView.blocked);
  // A close (agent or workspace) awaiting confirmation ([U6]).
  const closeFlow = useCloseFlow(deck, {
    onError: (message) => pushAlert("Worktree error", message),
    // The same heading the ⇧⌘W path uses: one refusal, one wording, one
    // title, whichever surface the user reached it from.
    onSuspendRefused: (message) =>
      pushAlert("Can't suspend this agent", message),
    gitPositions: gitHeads,
    blockedPanes: runView.blocked,
    suspendAgent: orchestrator.suspend,
    closeAgents: orchestrator.close,
  });
  // The command registry's core set — spawn/focus/close/switch/write behind
  // one executor, for every invoker (voice, MCP, a future palette). Closes go
  // through the same confirm flow as ⌘W.
  useCoreCommands({
    deck,
    agents,
    requestCloseAgent: closeFlow.requestCloseAgent,
    suspendAgent: orchestrator.suspend,
    resumeAgent: orchestrator.resume,
    createPane: orchestrator.createPane,
    // A command reaches these from voice/MCP/a plugin, where no button was
    // disabled to stop it — so they ask the same gate the UI does and answer
    // whether they actually opened. Reading `canOpenDialog` from the enclosing
    // render is sound: the hook re-reads its deps every render, so the closure
    // that runs is always the current one.
    openSettings: (sectionId) => {
      if (!canOpenDialog) return false;
      setSettingsSection(sectionId ?? undefined);
      setSettingsOpen(true);
      return true;
    },
    openUsage: () => {
      if (!canOpenDialog) return false;
      setStatsOpen(true);
      return true;
    },
  });
  // The plugin system: the bridge wires deck accessors + deck events; the
  // built-ins boot once (bootstrapPlugins waits for settings itself — enabled
  // flags and every plugin's values live there); the contribution registries
  // drive the dock and the top bar below.
  usePluginDeckBridge(deck);
  useEffect(() => {
    void bootstrapPlugins();
  }, [bootstrapPlugins]);
  const pluginDockTabs = useContributions(pluginRegistries.dockTabs);
  const pluginTopBarActions = useContributions(pluginRegistries.topBarActions);
  // Runtime crash reports — they flip a plugin's tab to the failure panel.
  const crashes = useSyncExternalStore(subscribePluginCrashes, pluginCrashes);

  // Drop a file onto a pane → paste its path into that pane's PTY and focus it
  // ([F4]). Two sources, one delivery: an OS file drop from Finder, and an
  // in-app pointer drag of a Files-plugin tree row.
  useDragDrop((paneId) => deck.selectPane(deck.activeId, paneId));
  usePaneDrag((paneId) => deck.selectPane(deck.activeId, paneId));

  const active = findWorkspace(deck.workspaces, deck.activeId) ?? null;
  // The active workspace's view — dock open/tab and pane selection all live in
  // one per-workspace object, so switching workspaces switches to that
  // workspace's own dock + selection state.
  const activeView = deck.viewOf(deck.activeId);
  // The dock — a persistent side panel like the rail, not a modal. Open or
  // closed is PER workspace, session-only.
  const dockOpen = activeView.dock ?? false;
  const showForm = creating || deck.workspaces.length === 0;
  const selectedPaneId = activeView.select ?? null;
  // The dock's tab list: every tab is a plugin contribution, rendered from
  // SNAPSHOTS inside its own error boundary (a crashing plugin tab must not
  // take the deck down). The dock itself is contribution-driven chrome: it
  // exists only while this list is non-empty.
  const dockTabs: DockTabItem[] = [
    ...(dockOpen && active
      ? pluginDockTabs.map((c) => {
          // Any crash badges every tab of the plugin, but the failure panel
          // REPLACES content only where the crash lives: this tab's own
          // crash, or an overlay's (shared, tab-less infrastructure — the
          // plugin's tabs are the only place its panel can live). A SIBLING
          // tab's crash leaves this tab's healthy content alone.
          const pluginCrashList = crashes.filter(
            (crash) => crash.pluginId === c.pluginId,
          );
          const panelCrashes = pluginCrashList.filter(
            (crash) =>
              crash.surfaceKind === "overlay" ||
              (crash.surfaceKind === "tab" && crash.surfaceId === c.entry.id),
          );
          return {
            id: `${c.pluginId}:${c.entry.id}`,
            label: c.entry.label,
            alert: pluginCrashList.length > 0,
            element:
              panelCrashes.length > 0 ? (
                <PluginFailurePanel
                  pluginId={c.pluginId}
                  label={c.entry.label}
                  crashes={panelCrashes}
                />
              ) : "Component" in c.entry ? (
                // Built-in tier: a trusted React component in the host tree.
                <ErrorBoundary
                  label={c.entry.label}
                  onError={(e) => {
                    log.error(
                      `web:plugin:${c.pluginId}`,
                      `dock tab "${c.entry.id}" crashed: ${describeError(e)}`,
                    );
                    reportPluginCrash(c.pluginId, "tab", c.entry.id, e);
                  }}
                >
                  <c.entry.Component
                    workspace={toWorkspaceSnapshot(active)}
                    selectedPaneId={selectedPaneId}
                  />
                </ErrorBoundary>
              ) : (
                // External tier: the plugin's own document at its own
                // kdplugin://<id> origin. allow-same-origin lets it load its own
                // scripts/assets under that origin (per-plugin CSP still bounds
                // its network); the origin — cross-origin to the host — is the
                // isolation boundary, so it can't reach the host or other plugins.
                <iframe
                  className="dock__plugin-frame"
                  title={c.entry.label}
                  sandbox="allow-scripts allow-same-origin"
                  src={externalPluginUrl(c.pluginId, c.entry.iframe)}
                />
              ),
          };
        })
      : []),
  ];
  const activeCount = active?.panes.length ?? 0;
  const atCap = activeCount >= MAX_PANES;
  // Transactional dialogs — while one is up, nothing else may open over it.
  // One list, one rule: a new dialog joins by being added here.
  const transactions = [
    agentFlow.dialog,
    closeFlow.closing,
    forkDialog,
    error,
    frozen && !frozenAck ? frozen : null,
  ];
  const dialogOpen = transactions.some((t) => t !== null);
  const modalOpen =
    showForm || dialogOpen || settingsOpen || statsOpen || skillsOpen;
  // The single "may another dialog open over what is up?" rule. Every surface
  // that can raise one asks THIS — buttons, hotkeys, notification navigation,
  // the update chip, and the command registry — because the question was
  // spelled four different ways across eleven sites and three of them omitted
  // `skillsOpen`. Stacking matters beyond looks: `useEscape` handlers are
  // window-level and stack, so one Escape peels both layers, and over an alert
  // that resolves to its confirm — dismissing a notice nobody read.
  //
  // `showForm` is deliberately absent: the create form is a passive surface,
  // and on first run it is the only screen there is, so blocking here would
  // make Settings unreachable.
  const canOpenDialog =
    !dialogOpen && !settingsOpen && !statsOpen && !skillsOpen;
  // The single "can add an agent" rule — a workspace is active, room under the
  // cap, and nothing modal is up. Both the ⌘T hotkey and the + Agent button
  // gate on this so they can't diverge (the button used to ignore modals).
  const canAddAgent = !!active && !atCap && !modalOpen;

  // The banner rule's "is the source on screen" probe — kept current through a
  // ref (the probe is registered once; re-registering per render would churn
  // the module store). A pane is on screen when nothing modal covers the deck,
  // its workspace is active, and the layout actually shows its body
  // (`paneOnScreen` — the same visibility semantics DeckStage renders).
  const visibilityRef = useRef({
    activeId: deck.activeId,
    workspaces: deck.workspaces,
    viewByWs: deck.viewByWs,
    deckLayout,
    minimizeOn,
    modalOpen,
  });
  visibilityRef.current = {
    activeId: deck.activeId,
    workspaces: deck.workspaces,
    viewByWs: deck.viewByWs,
    deckLayout,
    minimizeOn,
    modalOpen,
  };
  useEffect(() => {
    setSourceVisibilityProbe((source) => {
      if (source.type !== "pane") return false;
      const now = visibilityRef.current;
      if (now.modalOpen || source.workspace.id !== now.activeId) return false;
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

  // Native-menu hotkeys: ⌘N opens the new-workspace form, ⌘T the spawn dialog,
  // ⌘W asks to close the selected pane (an empty workspace: the workspace
  // itself), ⇧⌘W stops it without asking, ⇧⌘M toggles its maximize. A hotkey
  // bypasses both button disabling and the modal overlay, so those guards are
  // mirrored here.
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
      // No confirmation, unlike ⌘W: suspending is reversible, and a modal per
      // parked agent would make the cheap gesture expensive. A REFUSAL does
      // get a word, though — a blind chord that silently does nothing is
      // indistinguishable from one that didn't reach the app at all.
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
      // The list layout has no maximize — writing a focus it doesn't render
      // would spring back as a surprise maximize on the return to the grid.
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
      // The create form is a passive surface, not a transaction — settings
      // open over it (on first run the form is the only screen there is, so
      // blocking would make settings unreachable). Its Esc yields while the
      // settings dialog is on top. The Stats and Skills dialogs DO block:
      // stacking Settings over either would give one Escape two layers to peel.
      if (!canOpenDialog) return;
      setSettingsSection(undefined);
      setSettingsOpen(true);
    },
  });

  const handleSelectWorkspace = (id: string) => {
    deck.selectWorkspace(id);
    // Returning from the create form (you can always go back to an existing one).
    setCreating(false);
  };

  // The bell's history + per-workspace unread tallies for the rail dots.
  const notifications = useNotifications();
  const unreadForWs = unreadByWorkspace(notifications);
  const notificationPrefs =
    settings?.notifications ?? DEFAULT_SETTINGS.notifications;
  const showBell =
    notificationPrefs.enabled && notificationPrefs.mode !== "system";

  // A clicked notification navigates to its origin: a pane is selected (and
  // restored from the minimize tray if needed), a plugin entry lands on its
  // precise workspace/dock target or falls back to that plugin's Settings,
  // and an app-level one opens Settings → Updates.
  const openNotification = (n: Notification) => {
    switch (n.source.type) {
      case "pane": {
        const { workspace, paneId } = n.source;
        // The history outlives workspaces (and a plugin may name a wsId we
        // never had): activating a gone id would strand the stage on a blank
        // active workspace — the reducer sets activeId unconditionally.
        const ws = workspaceForNotification(deck.workspaces, workspace);
        if (!ws) return;
        handleSelectWorkspace(workspace.id);
        if (deck.viewOf(workspace.id).minimized?.includes(paneId)) {
          deck.toggleMinimize(workspace.id, paneId);
        }
        // Generation matching identifies the workspace; pane ownership keeps
        // a stale/invalid pane source from poisoning its current selection.
        if (ws.panes.some((pane) => pane.id === paneId)) {
          deck.selectPane(workspace.id, paneId);
        }
        break;
      }
      case "plugin": {
        let preciseTargetResolved = true;
        if (n.source.workspace !== undefined) {
          const ws = workspaceForNotification(
            deck.workspaces,
            n.source.workspace,
          );
          if (ws) {
            handleSelectWorkspace(ws.id);
          } else {
            preciseTargetResolved = false;
          }
        }
        if (shouldRevealPluginDock(n.source, preciseTargetResolved)) {
          preciseTargetResolved =
            revealPluginDockTab(n.source.pluginId, n.source.dockTab) &&
            preciseTargetResolved;
        }
        const section = settingsSectionForNotification(
          n.source,
          preciseTargetResolved,
        );
        if (section !== null && canOpenDialog) {
          setSettingsSection(section);
          setSettingsOpen(true);
        }
        break;
      }
      case "app": {
        // Same guard as the top bar's update chip: the dialog reads its
        // section only at open, so setting it over an open dialog would
        // silently not navigate.
        if (canOpenDialog) {
          setSettingsSection(
            settingsSectionForNotification(n.source) ?? undefined,
          );
          setSettingsOpen(true);
        }
        break;
      }
      default: {
        // Exhaustiveness: a new NotificationSource variant must fail to
        // compile here instead of silently getting no navigation.
        const unhandled: never = n.source;
        void unhandled;
      }
    }
  };

  const handleCreateWorkspace = (config: SpawnConfig) => {
    // Optimistic: the workspace (and its provisioning cards) land at once.
    const result = orchestrator.createWorkspace(config);
    if (!result.ok) {
      pushAlert(
        "Workspace creation failed",
        result.reason === "sequence-exhausted"
          ? "No numeric workspace ID is available. Remove the workspace with the highest numeric ID and try again."
          : "The allocated workspace ID is already in use. Please try again.",
      );
      return;
    }
    setCreating(false);
  };

  const railWorkspaces = deck.workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    agentCount: w.panes.length,
    // The dots belong to the bell: without it (system-only mode, or a
    // mid-session switch to it) there is nothing to open or mark read, so a
    // populated runtime list must not leave unclearable dots behind.
    unread: showBell ? (unreadForWs.get(w.instance) ?? 0) : 0,
  }));

  // While the saved deck (or the spawn context, or the settings) is loading,
  // paint only the shell background — the boot splash covers this moment;
  // rendering panes before the spawn context arrives would spawn them without
  // their session identity ([F7]/[F8]), and terminals read the scrollback
  // setting at construction ([F6]).
  if (restoring || !spawnCtx || !settings) return <div className="deck" />;

  return (
    <div className="deck">
      <header className="deck__bar">
        <div className="deck__bar-left">
          <button
            type="button"
            className="bar__icon"
            onClick={() => setRailCollapsed((c) => !c)}
            title={railCollapsed ? "Show workspaces" : "Hide workspaces"}
            aria-label="Toggle workspaces panel"
          >
            <SidebarIcon />
          </button>
          <span className="deck__brand">KeepDeck</span>
          {railCollapsed && active && (
            <span className="deck__active-ws" title={active.name}>
              {active.name}
            </span>
          )}
        </div>
        <div className="deck__bar-right">
          {isFoundUpdate(updateState) && (
            // The consent ladder's face in the bar: "available" only points
            // at the Updates section (nothing downloads by itself), "ready"
            // restarts into the already-verified download. The deck revives
            // after the restart through workspace persistence.
            <button
              type="button"
              className="bar__action bar__action--update"
              onClick={() => {
                if (updateState.phase === "ready") {
                  void restartToUpdate();
                } else if (canOpenDialog) {
                  setSettingsSection("updates");
                  setSettingsOpen(true);
                }
              }}
              disabled={
                updateState.phase === "downloading" ||
                updateState.phase === "discarding" ||
                updateState.phase === "installing"
              }
              title={
                updateState.phase === "ready"
                  ? `Update to ${updateState.version ?? "new version"} and restart`
                  : `Version ${updateState.version ?? "?"} is available`
              }
            >
              {updateState.phase === "available" && "Update available"}
              {updateState.phase === "downloading" && "Downloading update…"}
              {updateState.phase === "ready" && "Update ready · Restart"}
              {updateState.phase === "discarding" && "Discarding update…"}
              {updateState.phase === "installing" && "Restarting…"}
            </button>
          )}
          {/* Provider limit chips — visible before the hand reaches for
              another agent; nothing renders until a first report lands. */}
          <UsageChips
            agents={agents}
            liveAgents={usageLiveAgents}
            onOpenStats={() => setStatsOpen(true)}
          />
          <button
            type="button"
            className="bar__action"
            onClick={() => {
              if (canAddAgent) void agentFlow.openFor(active);
            }}
            disabled={!canAddAgent}
            title={atCap ? `Max ${MAX_PANES} agents` : "Add agent"}
          >
            + Agent
          </button>
          <span className="deck__status">
            {activeCount} {activeCount === 1 ? "pane" : "panes"}
            {info ? ` · ${info.version}` : ""}
          </span>
          {pluginDockTabs.length > 0 && (
            // The dock is the first icon in the utility cluster: it changes
            // the deck's primary layout, so transient tools must not move it.
            <button
              type="button"
              className="bar__icon"
              onClick={() => active && deck.toggleDock(active.id)}
              title={dockOpen ? "Hide the dock" : "Show the dock"}
              aria-label="Toggle dock panel"
            >
              <DockIcon />
            </button>
          )}
          {pluginTopBarActions.map((c) => (
            // Plugin top-bar actions follow the stable layout toggle, in
            // contribution order, before the remaining built-in tools.
            <button
              key={`${c.pluginId}:${c.entry.id}`}
              type="button"
              className="bar__icon"
              onClick={() => c.entry.run()}
              title={c.entry.title}
              aria-label={c.entry.title}
            >
              {c.entry.Icon ? <c.entry.Icon /> : c.entry.title.slice(0, 1)}
            </button>
          ))}
          <button
            type="button"
            className="bar__icon"
            onClick={() => setStatsOpen(true)}
            disabled={!canOpenDialog}
            title="Usage statistics"
            aria-label="Open usage statistics"
          >
            <StatsIcon />
          </button>
          {showBell && <NotificationBell onOpen={openNotification} />}
          <button
            type="button"
            className="bar__icon"
            onClick={() => setSkillsOpen(true)}
            // Same modal etiquette as the gear: one dialog at a time.
            disabled={!canOpenDialog}
            title="Skills"
            aria-label="Open skills"
          >
            <SkillsIcon />
          </button>
          <button
            type="button"
            className="bar__icon"
            onClick={() => {
              setSettingsSection(undefined);
              setSettingsOpen(true);
            }}
            // Mirrors the ⌘, guard. The create form does NOT disable this:
            // on first run it's the only screen, and settings must stay
            // reachable over it (e.g. to pick the default agent first).
            disabled={!canOpenDialog}
            title="Settings"
            aria-label="Open settings"
          >
            <GearIcon />
          </button>
        </div>
      </header>
      <div className="deck__body">
        {!railCollapsed && (
          <WorkspacesRail
            workspaces={railWorkspaces}
            activeId={deck.activeId}
            onSelect={handleSelectWorkspace}
            onAdd={() => setCreating(true)}
            onClose={closeFlow.requestCloseWorkspace}
            onRename={deck.renameWorkspace}
            onReorder={deck.moveWorkspace}
          />
        )}
        <div className="deck__stage">
          <DeckStage
            workspaces={deck.workspaces}
            activeId={deck.activeId}
            viewByWs={deck.viewByWs}
            selectedPaneId={selectedPaneId}
            deckLayout={deckLayout}
            minimizeStyle={minimizeStyle}
            agents={agents}
            agentsReady={!agentsLoading}
            unavailableAgentReasons={unavailableReasons}
            gitHeads={gitHeads}
            journal={deck.journal.records}
            onDeleteJournalRecord={deck.deleteJournalRecord}
            onResumeSession={(wsId, record) =>
              void orchestrator.resumeSession(wsId, record).catch((e: unknown) =>
                // A user-requested continuation must fail VISIBLY — the row
                // staying put with no signal reads as a dead button. Queued
                // behind whatever is up: a slow earlier failure must not be
                // clobbered by a later one, and neither is dropped.
                pushAlert("Could not resume the session", describeError(e)),
              )
            }
            onForkSession={(wsId, record) => setForkDialog({ wsId, record })}
            browser={sessionsBrowser}
            onSelectPane={deck.selectPane}
            onToggleFocus={deck.toggleFocus}
            onToggleMinimize={deck.toggleMinimize}
            onCloseAgent={closeFlow.requestCloseAgent}
            onRenamePane={deck.renamePane}
            onPaneTitle={deck.setPaneAutoTitle}
            idleBlocked={runView.blocked}
            wakeFailed={runView.wakeFailed}
            specByPane={specByPane}
            failedPanes={failedPanes}
            onStartFresh={orchestrator.startFresh}
            onResumeAgent={orchestrator.resume}
            onRetryProvision={orchestrator.retryProvisioning}
            onAgentExited={(wsId, paneId, code) => {
              // The one-shot boot-resume recovery respawns by itself — that
              // exit is not a crash. A clean exit (code 0) is the user's own
              // doing inside the pane; only abnormal ends notify.
              const recovering = orchestrator.recoverRejectedResume(
                wsId,
                paneId,
                code,
              );
              if (!recovering && code !== 0) {
                notifyAgentCrashed(deck.workspaces, wsId, paneId, code, agents);
              }
            }}
            onAgentSpawnFailed={(wsId, paneId, message) =>
              notifyAgentSpawnFailed(deck.workspaces, wsId, paneId, message, agents)
            }
            onRestartAgent={orchestrator.restart}
            restartEpochs={runView.epochs}
            onRetryPlanBuild={orchestrator.retryPlanBuild}
          />

          {showForm &&
            (deck.workspaces.length > 0 ? (
              // Creating another workspace: a true blocking modal over the deck.
              <ModalOverlay>
                <WorkspaceForm
                  onCreate={handleCreateWorkspace}
                  // Esc must peel one layer at a time: while another global
                  // dialog is above this form, the form's own Esc yields
                  // (an undefined onCancel also hides the covered button).
                  onCancel={
                    !canOpenDialog
                      ? undefined
                      : () => setCreating(false)
                  }
                  pickFolder={pickFolder}
                  inspectDir={inspectRepo}
                />
              </ModalOverlay>
            ) : (
              // First-run: the opaque empty-state setup screen (no cancel — it
              // IS the content, not a dialog over it), kept inside the stage.
              <div className="deck__overlay">
                <WorkspaceForm
                  onCreate={handleCreateWorkspace}
                  pickFolder={pickFolder}
                  inspectDir={inspectRepo}
                />
              </div>
            ))}

          {agentFlow.dialog && (
            <AgentDialog
              defaultAgentType={agentFlow.dialog.defaultAgentType}
              defaultYolo={agentFlow.dialog.defaultYolo}
              remoteEnabled={agentFlow.dialog.remoteEnabled}
              repo={agentFlow.dialog.repo}
              suggestedPath={agentFlow.dialog.suggestedPath}
              suggestedBranch={agentFlow.dialog.suggestedBranch}
              probePath={probeWorktree}
              listBranches={listBranches}
              branchForPath={agentFlow.branchFor}
              occupancyAt={(path) => pathOccupancy(deck.workspaces, path)}
              nextFreeLocation={agentFlow.nextFree}
              pickFolder={pickFolder}
              searchSessions={agentFlow.searchSessions}
              sessionClaim={agentFlow.sessionClaim}
              onConfirm={agentFlow.confirm}
              onCancel={agentFlow.cancel}
            />
          )}

          {forkDialog && (
            <ForkTargetDialog
              record={forkDialog.record}
              agents={agents}
              workspaceCwd={
                findWorkspace(deck.workspaces, forkDialog.wsId)?.cwd ?? ""
              }
              defaultYolo={settings.defaultYolo}
              probe={probeWorktree}
              occupancy={(path) => pathOccupancy(deck.workspaces, path)}
              pickFolder={pickFolder}
              onConfirm={({ target, yolo }) => {
                const { wsId, record } = forkDialog;
                setForkDialog(null);
                void orchestrator.forkSession(wsId, record, target, { yolo }).catch((e: unknown) =>
                  // Surgery failures carry precise store diagnostics — show
                  // them; a silently closing dialog reads as success.
                  pushAlert("Could not fork the session", describeError(e)),
                );
              }}
              onCancel={() => setForkDialog(null)}
            />
          )}

          {error && (
            // Keyed by position in the queue so the NEXT notice mounts a
            // fresh dialog instead of reconciling into this one. Reconciled,
            // it kept the OK button focused and its own text swapped
            // underneath — a second Enter dismissed a message that was never
            // read, which is the silent drop the queue exists to end.
            <ConfirmDialog
              key={alertSeq}
              title={error.title}
              message={error.message}
              confirmLabel="OK"
              onConfirm={dismissAlert}
            />
          )}

          {frozen && !frozenAck && (
            // The parked-session notice: silent no-saving would be hidden
            // data loss — this turns it into an announced trade-off. Both
            // parks say the same thing about THIS session; they differ in
            // what they can honestly say about the file.
            <ConfirmDialog
              title={
                frozen.kind === "newer-build"
                  ? "Deck from a newer KeepDeck"
                  : "Couldn't read your deck"
              }
              message={
                (frozen.kind === "newer-build"
                  ? `deck.json was written by a newer version of KeepDeck ` +
                    `(revision ${frozen.version}; this build reads up to revision ${DECK_STATE_VERSION}). ` +
                    `The file is left untouched.\n\n`
                  : `deck.json could not be read, so its contents are unknown. ` +
                    `The file is left untouched rather than overwritten.\n\n`) +
                `This session starts empty and will not be saved — anything ` +
                `you create here is gone on quit. ` +
                (frozen.kind === "newer-build"
                  ? `Run the newer version to get your workspaces back.`
                  : `Restart KeepDeck to try reading it again.`)
              }
              confirmLabel="OK"
              onConfirm={() => setFrozenAck(true)}
            />
          )}

          {settingsOpen && (
            <SettingsDialog
              initialSectionId={settingsSection}
              onClose={() => {
                setSettingsOpen(false);
                // Clear the target so the next gear open lands on the first
                // section, not a stale plugin/Updates page.
                setSettingsSection(undefined);
              }}
            />
          )}

          {statsOpen && <StatsDialog onClose={() => setStatsOpen(false)} />}

          {skillsOpen && (
            <SkillsDialog
              activeWs={active ? { id: active.id, name: active.name } : null}
              onClose={() => setSkillsOpen(false)}
            />
          )}

          {closeFlow.closing && (
            <ConfirmDialog
              title={
                closeFlow.closing.kind === "agent"
                  ? `Close agent "${closeFlow.closing.label}"?`
                  : `Close workspace "${closeFlow.closing.name}"?`
              }
              // Written by the flow that knows what confirming will do, so
              // the sentence and the action can't drift apart.
              message={closeFlow.closeMessage}
              confirmLabel="Close"
              cancelLabel="Cancel"
              destructive
              secondaryAction={
                closeFlow.canSuspendInstead
                  ? {
                      label: "Suspend",
                      onClick: closeFlow.suspendInstead,
                      disabled: closeFlow.deleteWorktree,
                      hint: "A suspended agent comes back to its worktree — untick the delete to suspend it",
                    }
                  : undefined
              }
              onConfirm={closeFlow.confirmClose}
              onCancel={closeFlow.cancelClose}
            >
              {closeFlow.closing.targets.length > 0 && (
                <label className="confirm__option">
                  <input
                    type="checkbox"
                    checked={closeFlow.deleteWorktree}
                    onChange={(e) =>
                      closeFlow.setDeleteWorktree(e.target.checked)
                    }
                  />
                  <span className="confirm__option-text">
                    {closeFlow.closing.targets.length === 1
                      ? "Also delete the worktree and its branches"
                      : `Also delete all ${closeFlow.closing.targets.length} worktrees and their branches`}
                    <span className="confirm__option-note">
                      Discards any uncommitted work.
                    </span>
                  </span>
                </label>
              )}
            </ConfirmDialog>
          )}
        </div>
        {dockTabs.length > 0 && active && (
          // The picked tab is remembered per workspace (activeView.dockTab),
          // so switching workspaces and back returns to that workspace's tab.
          // Still keyed by workspace: the remount resets plugin-internal
          // tab state (run target, drafts) to the new workspace's context —
          // the selected tab survives it because it lives in the deck.
          <DockPanel
            key={active.instance}
            tabs={dockTabs}
            activeTab={activeView.dockTab ?? null}
            onSelectTab={(id) => deck.setDockTab(active.id, id)}
          />
        )}
      </div>
      {/* Plugin residents — mounted for each active plugin's whole lifetime,
          independent of the dock. What they render is theirs. */}
      <PluginOverlays />
    </div>
  );
}

function StatsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M22 20H2" />
    </svg>
  );
}

function SkillsIcon() {
  // An open book — the skills library.
  return (
    <svg
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z" />
      <path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function DockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="15" y1="4" x2="15" y2="20" />
    </svg>
  );
}

function SidebarIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  );
}

export default App;
