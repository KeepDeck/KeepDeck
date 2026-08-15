import { askForPaneBack } from "./app/resumeOutcome";
import { TeamDialog } from "./components/workspace/TeamDialog";
import { isFoundUpdate, restartToUpdate } from "./app/updateManager";
import { useAppController } from "./app/useAppController";
import { useAppRuntime } from "./app/runtimeContext";
import {
  DockIcon,
  GearIcon,
  SidebarIcon,
  SkillsIcon,
  StatsIcon,
} from "./components/AppIcons";
import { DeckStage } from "./components/DeckStage";
import { DockPanel } from "./components/dock/DockPanel";
import { NotificationBell } from "./components/notifications/NotificationBell";
import { notificationCenter } from "./app/notificationCenter";
import { PluginOverlays } from "./components/PluginOverlays";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { SkillsDialog } from "./components/skills/SkillsDialog";
import { StatsDialog } from "./components/stats/StatsDialog";
import { UsageChips } from "./components/usage/UsageChips";
import { AgentDialog } from "./components/workspace/AgentDialog";
import { ForkTargetDialog } from "./components/workspace/ForkTargetDialog";
import { WorkspacesRail } from "./components/workspace/WorkspacesRail";
import { WorkspaceForm } from "./components/workspace/WorkspaceForm";
import {
  DECK_STATE_VERSION,
  findWorkspace,
  MAX_PANES,
  pathOccupancy,
} from "./domain/deck";
import { pickFolder } from "./ipc/dialogs";
import { describeError } from "./ipc/log";
import { inspectRepo, listBranches, probeWorktree } from "./ipc/worktree";
import {
  notifyAgentCrashed,
  notifyAgentSpawnFailed,
} from "./app/notificationProducers";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { ModalOverlay } from "./ui/ModalOverlay";
import "./styles/index.css";

function App() {
  const controller = useAppController();
  // The status tracker feeds the team dialog's live activity column; read
  // here (before the ready gate — hooks run unconditionally) and passed as
  // a port, so the dialog stays testable with a literal.
  const { statusTracker } = useAppRuntime();
  if (!controller.ready) return <div className="deck" />;
  const {
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
    canCloseDialog,
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
    paneViewActions,
    pluginDockTabs,
    pluginTopBarActions,
    pushAlert,
    railCollapsed,
    railWorkspaces,
    runView,
    sessionsBrowser,
    setCreating,
    setForkDialog,
    teamDialog,
    setTeamDialog,
    teamFlow,
    setFrozenAck,
    setRailCollapsed,
    openSettings,
    closeSettings,
    openSkills,
    closeSkills,
    openStats,
    closeStats,
    selectStatsTab,
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
    keyboardFocusEnabled,
  } = controller;
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
            <button
              type="button"
              className="bar__action bar__action--update"
              onClick={() => {
                if (updateState.phase === "ready") {
                  void restartToUpdate();
                } else {
                  openSettings("updates");
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
          <UsageChips
            agents={agents}
            liveAgents={usageLiveAgents}
            onOpenStats={() => void openStats()}
          />
          <button
            type="button"
            className="bar__action"
            onClick={() => {
              if (canAddAgent && active) void agentFlow.openFor(active);
            }}
            disabled={!canAddAgent}
            title={atCap ? `Max ${MAX_PANES} agents` : "Add agent"}
          >
            + Agent
          </button>
          {settings.agentTeams && active && (
            // Beside "+ Agent" because it is the same kind of act — setting
            // up who is working here — and because a team is a property of
            // this workspace, which is what this bar is about. Shown only
            // while the experiment is on, so nobody else pays a button for
            // it.
            //
            // ALWAYS a new one, the way "+ Agent" beside it always adds an
            // agent. An existing team is opened from the badge on any pane
            // that is on it, which is where somebody looking at a team is
            // already looking — and it is the gesture that scales, since a
            // workspace may run several.
            <button
              type="button"
              className="bar__action"
              onClick={() => setTeamDialog({ editing: null })}
              title="Group agents into a team so they can write to each other by role"
            >
              + Team
            </button>
          )}
          <span className="deck__status">
            {activeCount} {activeCount === 1 ? "pane" : "panes"}
            {info ? ` · ${info.version}` : ""}
          </span>
          {pluginDockTabs.length > 0 && (
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
            onClick={() => void openStats()}
            disabled={!canOpenDialog}
            title="Statistics"
            aria-label="Open statistics"
          >
            <StatsIcon />
          </button>
          {showBell && (
            <NotificationBell
              center={notificationCenter}
              onOpen={openNotification}
            />
          )}
          <button
            type="button"
            className="bar__icon"
            onClick={() => void openSkills()}
            disabled={!canOpenDialog}
            title="Skills"
            aria-label="Open skills"
          >
            <SkillsIcon />
          </button>
          <button
            type="button"
            className="bar__icon"
            onClick={() => void openSettings()}
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
            keyboardFocusEnabled={keyboardFocusEnabled}
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
                pushAlert("Could not resume the session", describeError(e)),
              )
            }
            onForkSession={(wsId, record) => setForkDialog({ wsId, record })}
            browser={sessionsBrowser}
            onSelectPane={deck.selectPane}
            onToggleFocus={paneViewActions.toggleMaximize}
            onToggleMinimize={deck.toggleMinimize}
            onRestoreSuspendedPane={deck.restoreSuspendedPane}
            onCloseAgent={closeFlow.requestCloseAgent}
            onRenamePane={deck.renamePane}
            // Only while the experiment is on — the same gate the bar's
            // button answers to, and without it no pane wears a badge to
            // click anyway.
            {...(settings.agentTeams
              ? { onOpenTeam: (name: string) => setTeamDialog({ editing: name }) }
              : {})}
            onPaneTitle={deck.setPaneAutoTitle}
            idleBlocked={runView.blocked}
            wakeFailed={runView.wakeFailed}
            specByPane={specByPane}
            failedPanes={failedPanes}
            onStartFresh={orchestrator.startFresh}
            onResumeAgent={(wsId, paneId) => {
              const refused = askForPaneBack(
                orchestrator.resume,
                deck.workspaces,
                agents,
                wsId,
                paneId,
              );
              if (refused) pushAlert("Can't resume this agent", refused);
            }}
            onRetryProvision={orchestrator.retryProvisioning}
            onAgentExited={(wsId, paneId, code) => {
              // Activity cleanup is NOT wired here on purpose: the status
              // channel watches the session registry and clears a dead
              // pane's activity itself — before this callback can even
              // fire, and even when the terminal is unmounted.
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
              notifyAgentSpawnFailed(
                deck.workspaces,
                wsId,
                paneId,
                message,
                agents,
              )
            }
            onRestartAgent={orchestrator.restart}
            restartEpochs={runView.epochs}
            onRetryPlanBuild={orchestrator.retryPlanBuild}
          />
          {showForm &&
            (deck.workspaces.length > 0 ? (
              <ModalOverlay>
                <WorkspaceForm
                  onCreate={handleCreateWorkspace}
                  onCancel={
                    !canOpenDialog ? undefined : () => setCreating(false)
                  }
                  pickFolder={pickFolder}
                  inspectDir={inspectRepo}
                />
              </ModalOverlay>
            ) : (
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
                void orchestrator
                  .forkSession(wsId, record, target, { yolo })
                  .catch((e: unknown) =>
                    pushAlert(
                      "Could not fork the session",
                      describeError(e),
                    ),
                  );
              }}
              onCancel={() => setForkDialog(null)}
            />
          )}
          {teamDialog && active && (
            <TeamDialog
              workspace={active}
              agents={agents}
              editing={teamDialog.editing}
              defaultYolo={settings.defaultYolo}
              activity={{
                subscribe: statusTracker.subscribe,
                of: (paneId) => statusTracker.getSnapshot().panes.get(paneId),
              }}
              onConfirm={(plan, closing) => {
                setTeamDialog(null);
                void teamFlow.apply(active.id, plan, closing);
              }}
              onCancel={() => setTeamDialog(null)}
            />
          )}
          {error && (
            <ConfirmDialog
              key={alertSeq}
              title={error.title}
              message={error.message}
              confirmLabel="OK"
              onConfirm={dismissAlert}
            />
          )}
          {frozen && !frozenAck && (
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
              onClose={closeSettings}
              canClose={canCloseDialog}
            />
          )}
          {statsOpen && (
            <StatsDialog
              tab={statsTab}
              onSelectTab={selectStatsTab}
              onClose={closeStats}
              canClose={canCloseDialog}
            />
          )}
          {skillsOpen && (
            <SkillsDialog
              activeWs={active ? { id: active.id, name: active.name } : null}
              onClose={closeSkills}
              canClose={canCloseDialog}
            />
          )}
          {closeFlow.closing && (
            <ConfirmDialog
              title={
                closeFlow.closing.kind === "agent"
                  ? `Close agent "${closeFlow.closing.label}"?`
                  : `Close workspace "${closeFlow.closing.name}"?`
              }
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
              {closeFlow.worktreeCount > 0 && (
                <label className="confirm__option">
                  <input
                    type="checkbox"
                    checked={closeFlow.deleteWorktree}
                    onChange={(e) =>
                      closeFlow.setDeleteWorktree(e.target.checked)
                    }
                  />
                  <span className="confirm__option-text">
                    {closeFlow.worktreeCount === 1
                      ? "Also delete the worktree and its branches"
                      : `Also delete all ${closeFlow.worktreeCount} worktrees and their branches`}
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
          <DockPanel
            key={active.instance}
            tabs={dockTabs}
            activeTab={activeView.dockTab ?? null}
            onSelectTab={(id) => deck.setDockTab(active.id, id)}
            mode={dockMode}
          />
        )}
      </div>
      <PluginOverlays />
    </div>
  );
}

export default App;
