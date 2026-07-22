import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DeckStage } from "./components/DeckStage";
import { WorkspacesRail } from "./components/workspace/WorkspacesRail";
import { WorkspaceForm } from "./components/workspace/WorkspaceForm";
import { AgentDialog } from "./components/workspace/AgentDialog";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { SkillsDialog } from "./components/skills/SkillsDialog";
import { fetchAppInfo, type AppInfo } from "./ipc/app";
import { restartToUpdate } from "./app/updateManager";
import { useUpdate } from "./app/useUpdate";
import { pickFolder } from "./ipc/dialogs";
import { describeError, log } from "./ipc/log";
import { inspectRepo, listBranches, probeWorktree } from "./ipc/worktree";
import { useAgents } from "./app/useAgents";
import { useDeck } from "./app/useDeck";
import { usePersistence } from "./app/usePersistence";
import { useJournalPersistence } from "./app/useJournalPersistence";
import { useJournalResume } from "./app/useJournalResume";
import { useJournalFork } from "./app/useJournalFork";
import { useSessionsBrowser } from "./app/useSessionsBrowser";
import { ForkTargetDialog } from "./components/workspace/ForkTargetDialog";
import type { SessionHandle } from "./domain/journal";
import { useSkillsPrune } from "./app/useSkillsPrune";
import { useRevive } from "./app/useRevive";
import { useSessionBinding } from "./app/useSessionBinding";
import { useUsageChannel } from "./app/useUsageChannel";
import { useSettings } from "./app/useSettings";
import { useMinimizeMode } from "./app/useMinimizeMode";
import { DEFAULT_SETTINGS } from "./domain/settings";
import { useSpawnContext } from "./app/useSpawnContext";
import { useGitHead } from "./app/useGitHead";
import { usePaneSpawnSpecs } from "./app/spawnSpecs";
import { useAgentRestart } from "./app/useAgentRestart";
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
import { useProvisioning } from "./app/useProvisioning";
import { useAgentDialog } from "./app/useAgentDialog";
import { useCloseFlow } from "./app/useCloseFlow";
import { useCoreCommands } from "./app/coreCommands";
import { useAppRuntime } from "./app/runtimeContext";
import { toWorkspaceSnapshot } from "./app/pluginSnapshots";
import { usePluginDeckBridge } from "./app/usePluginDeckBridge";
import { useContributions } from "./plugins";
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
  const { bootstrapPlugins, pluginRegistries, revealPluginDockTab } =
    useAppRuntime().plugins;
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
  const deck = useDeck();
  // The agent catalog: cli plugins' contributions + install detection.
  const { agents, loading: agentsLoading } = useAgents();
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
  // and on every close. Never while restoring/frozen — an unhydrated deck
  // reads as "no workspaces" and would sweep the live dirs too.
  useSkillsPrune(deck.workspaces, !restoring && !frozen);
  const [frozenAck, setFrozenAck] = useState(false);
  // Per-install spawn-plan constants (bridge inbox, reporter activation) — the
  // deck's first paint waits for it ([F7]/[F8] session identity v2).
  const spawnCtx = useSpawnContext();
  // Wake restored panes lazily per workspace — resuming recorded sessions —
  // and report gone directories ([F7]/[F8]).
  const revive = useRevive(deck, agents, spawnCtx, !agentsLoading);
  // Manual exited-card restart plus the separate, one-shot recovery for a
  // rejected boot resume. Both replace only runtime PTY/spec state; the pane
  // keeps its identity and layout position.
  const agentRestart = useAgentRestart(deck, spawnCtx);
  const journalResume = useJournalResume(deck, spawnCtx);
  const journalFork = useJournalFork(deck, spawnCtx);
  const sessionsBrowser = useSessionsBrowser();
  // The fork-target dialog's subject, when one is open.
  const [forkDialog, setForkDialog] = useState<{
    wsId: string;
    record: SessionHandle;
  } | null>(null);
  // Every live pane's spawn plan, built through its agent plugin's hooks
  // (async — the pane's terminal waits for its plan; mounting is what
  // spawns). Dormant panes get theirs at revive time.
  // Restart epochs force a full remount only after an explicit manual restart
  // (or the accepted boot-recovery exception) has retired the old PTY entry.
  const specByPane = usePaneSpawnSpecs(
    deck.workspaces,
    spawnCtx,
    !agentsLoading,
    agentRestart.epochs,
  );
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
        // only wakes the active workspace). Same filter as the tail and
        // polling lanes.
        if (pane.dormant || pane.provisioning) continue;
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
  // In-app error notice (no system dialogs). The title belongs to the caller:
  // worktree cleanup and workspace allocation are separate failure domains.
  const [error, setError] = useState<{
    title: string;
    message: string;
  } | null>(null);
  // The settings dialog ([F6]) — opened from the app menu (⌘,), the gear, or
  // a plugin's `openSettings`. When a plugin opens it, the target section id
  // rides along so the dialog lands on that plugin's page.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The shared-skills library editor ([skills]) — opened from the top bar.
  const [skillsOpen, setSkillsOpen] = useState(false);
  // Which section the dialog opens on: the gear opens the first section, the
  // top bar's update chip jumps to Updates, and a plugin's `settings.open`
  // command jumps to that plugin's page.
  const [settingsSection, setSettingsSection] = useState<string | undefined>();
  const provisioning = useProvisioning(deck);
  // "+ Agent" dialog — always shown, to pick the agent type (+ name, and the
  // per-agent worktree location, [F2]).
  const agentFlow = useAgentDialog(deck, agents, {
    // The dialog's "Start from" continuations, with the same visible-failure
    // contract as the journal rows' Resume/Fork below.
    resume: (wsId, handle, opts) =>
      void journalResume.resume(wsId, handle, opts).catch((e: unknown) =>
        setError((current) => current ?? {
          title: "Could not resume the session",
          message: describeError(e),
        }),
      ),
    fork: (wsId, handle, target, opts) =>
      void journalFork.fork(wsId, handle, target, opts).catch((e: unknown) =>
        setError((current) => current ?? {
          title: "Could not fork the session",
          message: describeError(e),
        }),
      ),
  });
  // A close (agent or workspace) awaiting confirmation ([U6]).
  const closeFlow = useCloseFlow(
    deck,
    // First error wins, like the resume/fork catches — a second failure
    // must not silently replace a dialog the user is reading.
    (message) =>
      setError((current) => current ?? { title: "Worktree error", message }),
    gitHeads,
  );
  // The command registry's core set — spawn/focus/close/switch/write behind
  // one executor, for every invoker (voice, MCP, a future palette). Closes go
  // through the same confirm flow as ⌘W.
  useCoreCommands({
    deck,
    agents,
    requestCloseAgent: closeFlow.requestCloseAgent,
    openSettings: (sectionId) => {
      setSettingsSection(sectionId ?? undefined);
      setSettingsOpen(true);
    },
  });
  // The plugin system: the bridge wires deck accessors + deck events; the
  // built-ins boot once settings settle (enabled flags live there); the
  // contribution registries drive the dock and the top bar below.
  usePluginDeckBridge(deck);
  useEffect(() => {
    if (settings) void bootstrapPlugins();
  }, [settings]);
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
    error,
    frozen && !frozenAck ? frozen : null,
  ];
  const dialogOpen = transactions.some((t) => t !== null);
  const modalOpen = showForm || dialogOpen || settingsOpen || skillsOpen;
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
  // itself), ⇧⌘M toggles its maximize. A hotkey
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
      // settings dialog is on top. The Skills dialog DOES block: stacking
      // Settings over it would give one Escape two layers to peel.
      if (dialogOpen || settingsOpen || skillsOpen) return;
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
        if (section !== null && !dialogOpen && !settingsOpen) {
          setSettingsSection(section);
          setSettingsOpen(true);
        }
        break;
      }
      case "app": {
        // Same guard as the top bar's update chip: the dialog reads its
        // section only at open, so setting it over an open dialog would
        // silently not navigate.
        if (!dialogOpen && !settingsOpen) {
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
    const result = provisioning.createWorkspace(config);
    if (!result.ok) {
      setError({
        title: "Workspace creation failed",
        message:
          result.reason === "sequence-exhausted"
            ? "No numeric workspace ID is available. Remove the workspace with the highest numeric ID and try again."
            : "The allocated workspace ID is already in use. Please try again.",
      });
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
          {(updateState.phase === "available" ||
            updateState.phase === "downloading" ||
            updateState.phase === "ready" ||
            updateState.phase === "discarding" ||
            updateState.phase === "installing") && (
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
                } else if (!dialogOpen && !settingsOpen) {
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
          {pluginTopBarActions.map((c) => (
            // Plugin top-bar actions, in contribution order, before the
            // built-in cluster.
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
          {pluginDockTabs.length > 0 && (
            // The dock toggle exists only while some plugin contributes a
            // dock tab — the dock is contribution-driven chrome.
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
          {showBell && <NotificationBell onOpen={openNotification} />}
          <button
            type="button"
            className="bar__icon"
            onClick={() => setSkillsOpen(true)}
            // Same modal etiquette as the gear: one dialog at a time.
            disabled={dialogOpen || settingsOpen || skillsOpen}
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
            disabled={dialogOpen || settingsOpen || skillsOpen}
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
            gitHeads={gitHeads}
            journal={deck.journal.records}
            onDeleteJournalRecord={deck.deleteJournalRecord}
            onResumeSession={(wsId, record) =>
              void journalResume.resume(wsId, record).catch((e: unknown) =>
                // A user-requested continuation must fail VISIBLY — the row
                // staying put with no signal reads as a dead button. First
                // error wins while its dialog is up: a slow earlier failure
                // must not be clobbered by a later one.
                setError((current) => current ?? {
                  title: "Could not resume the session",
                  message: describeError(e),
                }),
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
            dormantBlocked={revive.blocked}
            specByPane={specByPane}
            onStartFresh={revive.startFresh}
            onRetryProvision={provisioning.retryPane}
            onAgentExited={(wsId, paneId, code) => {
              // The one-shot boot-resume recovery respawns by itself — that
              // exit is not a crash. A clean exit (code 0) is the user's own
              // doing inside the pane; only abnormal ends notify.
              const recovering = agentRestart.recoverRejectedResume(
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
            onRestartAgent={agentRestart.restart}
            restartEpochs={agentRestart.epochs}
          />

          {showForm &&
            (deck.workspaces.length > 0 ? (
              // Creating another workspace: a true blocking modal over the deck.
              <ModalOverlay>
                <WorkspaceForm
                  onCreate={handleCreateWorkspace}
                  // Esc must peel one layer at a time: while the settings
                  // dialog is above this form, the form's own Esc yields
                  // (an undefined onCancel also hides the covered button).
                  onCancel={settingsOpen || skillsOpen ? undefined : () => setCreating(false)}
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
              probe={probeWorktree}
              occupancy={(path) => pathOccupancy(deck.workspaces, path)}
              pickFolder={pickFolder}
              onConfirm={(target) => {
                const { wsId, record } = forkDialog;
                setForkDialog(null);
                void journalFork.fork(wsId, record, target).catch((e: unknown) =>
                  // Surgery failures carry precise store diagnostics — show
                  // them; a silently closing dialog reads as success.
                  setError((current) => current ?? {
                    title: "Could not fork the session",
                    message: describeError(e),
                  }),
                );
              }}
              onCancel={() => setForkDialog(null)}
            />
          )}

          {error && (
            <ConfirmDialog
              title={error.title}
              message={error.message}
              confirmLabel="OK"
              onConfirm={() => setError(null)}
            />
          )}

          {frozen && !frozenAck && (
            // The parked-session notice: silent no-saving would be hidden
            // data loss — this turns it into an announced trade-off.
            <ConfirmDialog
              title="Deck from a newer KeepDeck"
              message={
                `deck.json was written by a newer version of KeepDeck ` +
                `(revision ${frozen.version}; this build reads up to revision ${DECK_STATE_VERSION}). ` +
                `The file is left untouched.\n\n` +
                `This session starts empty and will not be saved — anything ` +
                `you create here is gone on quit. Run the newer version to ` +
                `get your workspaces back.`
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
              message={
                closeFlow.closing.kind === "agent"
                  ? "Its terminal session will be ended."
                  : closeFlow.closing.count === 0
                    ? "This workspace has no agents."
                    : `This ends ${closeFlow.closing.count} agent${closeFlow.closing.count === 1 ? "" : "s"} and their sessions.`
              }
              confirmLabel="Close"
              cancelLabel="Cancel"
              destructive
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
