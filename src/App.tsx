import { useEffect, useState, useSyncExternalStore } from "react";
import { DeckStage } from "./components/DeckStage";
import { WorkspacesRail } from "./components/workspace/WorkspacesRail";
import { WorkspaceForm } from "./components/workspace/WorkspaceForm";
import { AgentDialog } from "./components/workspace/AgentDialog";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { fetchAppInfo, type AppInfo } from "./ipc/app";
import { restartToUpdate } from "./app/updateManager";
import { useUpdate } from "./app/useUpdate";
import { pickFolder } from "./ipc/dialogs";
import { describeError, log } from "./ipc/log";
import { inspectRepo, listBranches, probeWorktree } from "./ipc/worktree";
import { useAgents } from "./app/useAgents";
import { useDeck } from "./app/useDeck";
import { usePersistence } from "./app/usePersistence";
import { useRevive } from "./app/useRevive";
import { useSessionBinding } from "./app/useSessionBinding";
import { useSettings } from "./app/useSettings";
import { DEFAULT_SETTINGS } from "./domain/settings";
import { useSpawnContext } from "./app/useSpawnContext";
import { useGitHead } from "./app/useGitHead";
import { usePaneSpawnSpecs } from "./app/spawnSpecs";
import { useAgentRestart } from "./app/useAgentRestart";
import { useProvisioning } from "./app/useProvisioning";
import { useAgentDialog } from "./app/useAgentDialog";
import { useCloseFlow } from "./app/useCloseFlow";
import { useCoreCommands } from "./app/coreCommands";
import { bootstrapPlugins, pluginRegistries } from "./app/pluginManager";
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
  distinctAgentTypes,
  findWorkspace,
  MAX_PANES,
  maximizeHotkeyTarget,
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
  const minimizeOn = deckLayout === "grid" && minimizeStyle !== "none";
  // Restore the saved deck on boot; save (debounced) on every change ([F7]).
  // `frozen` = the stored deck needs a newer build: session parked, no saves.
  const { restoring, frozen } = usePersistence(deck);
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
  // Runtime git HEAD observations for pane badges and worktree close cleanup.
  const gitHeads = useGitHead(deck);
  // The new-workspace form is open (also shown whenever there are no workspaces).
  const [creating, setCreating] = useState(false);
  // Whether the left Workspaces rail is collapsed.
  const [railCollapsed, setRailCollapsed] = useState(false);
  // In-app error notice (no system dialogs).
  const [error, setError] = useState<string | null>(null);
  // The settings dialog ([F6]) — opened from the app menu (⌘,), the gear, or
  // a plugin's `openSettings`. When a plugin opens it, the target section id
  // rides along so the dialog lands on that plugin's page.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which section the dialog opens on: the gear opens the first section, the
  // top bar's update chip jumps to Updates, and a plugin's `settings.open`
  // command jumps to that plugin's page.
  const [settingsSection, setSettingsSection] = useState<string | undefined>();
  const provisioning = useProvisioning(deck, agents);
  // "+ Agent" dialog — always shown, to pick the agent type (+ name, and the
  // per-agent worktree location, [F2]).
  const agentFlow = useAgentDialog(deck, agents);
  // A close (agent or workspace) awaiting confirmation ([U6]).
  const closeFlow = useCloseFlow(deck, setError, gitHeads);
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
  const modalOpen = showForm || dialogOpen || settingsOpen;
  // The single "can add an agent" rule — a workspace is active, room under the
  // cap, and nothing modal is up. Both the ⌘T hotkey and the + Agent button
  // gate on this so they can't diverge (the button used to ignore modals).
  const canAddAgent = !!active && !atCap && !modalOpen;

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
      // settings dialog is on top.
      if (dialogOpen || settingsOpen) return;
      setSettingsSection(undefined);
      setSettingsOpen(true);
    },
  });

  const handleSelectWorkspace = (id: string) => {
    deck.selectWorkspace(id);
    // Returning from the create form (you can always go back to an existing one).
    setCreating(false);
  };

  const handleCreateWorkspace = (config: SpawnConfig) => {
    // Optimistic: the workspace (and its provisioning cards) land at once.
    provisioning.createWorkspace(config);
    setCreating(false);
  };

  const railWorkspaces = deck.workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    agentCount: w.panes.length,
    agentIcons: distinctAgentTypes(w.panes).map(
      (type) => agents.find((a) => a.id === type)?.icon ?? null,
    ),
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
              {updateState.phase === "installing" && "Restarting…"}
            </button>
          )}
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
            disabled={dialogOpen || settingsOpen}
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
            onStartWorkspace={(wsId, count) =>
              void provisioning.startWorkspace(wsId, count)
            }
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
            onAgentExited={agentRestart.recoverRejectedResume}
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
                  onCancel={settingsOpen ? undefined : () => setCreating(false)}
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
              repo={agentFlow.dialog.repo}
              suggestedPath={agentFlow.dialog.suggestedPath}
              suggestedBranch={agentFlow.dialog.suggestedBranch}
              probePath={probeWorktree}
              listBranches={listBranches}
              branchForPath={agentFlow.branchFor}
              occupancyAt={(path) => pathOccupancy(deck.workspaces, path)}
              nextFreeLocation={agentFlow.nextFree}
              pickFolder={pickFolder}
              onConfirm={agentFlow.confirm}
              onCancel={agentFlow.cancel}
            />
          )}

          {error && (
            <ConfirmDialog
              title="Worktree error"
              message={error}
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
                      ? "Also delete the worktree and branch"
                      : `Also delete all ${closeFlow.closing.targets.length} worktrees and branches`}
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
            key={active.id}
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
