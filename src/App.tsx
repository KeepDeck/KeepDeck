import { askForPaneBack } from "./app/resumeOutcome";
import { ArtifactsDialog } from "./components/artifacts/ArtifactsDialog";
import { TeamDialog } from "./components/workspace/TeamDialog";
import { restartToUpdate } from "./app/updateManager";
import { updateActionView } from "./app/updateAction";
import { useAppController } from "./app/useAppController";
import { useAppRuntime } from "./app/runtimeContext";
import { DeckBar } from "./components/deck/DeckBar";
import { DeckStage } from "./components/DeckStage";
import { DockPanel } from "./components/dock/DockPanel";
import { notificationCenter } from "./app/notificationCenter";
import { PluginOverlays } from "./components/PluginOverlays";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { SkillsDialog } from "./components/skills/SkillsDialog";
import { StatsDialog } from "./components/stats/StatsDialog";
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
import { liveOutsideSessions } from "./app/liveSessions";
import { useCallback } from "react";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { ModalOverlay } from "./ui/ModalOverlay";
import "./styles/index.css";

function App() {
  const controller = useAppController();
  // The status tracker feeds the team dialog's live activity column; read
  // here (before the ready gate — hooks run unconditionally) and passed as
  // a port, so the dialog stays testable with a literal.
  const { statusTracker, plugins } = useAppRuntime();
  // The resume picker's advisory live-registry ask — handed to the dialog
  // READY-MADE (the same seam the session search uses; a view never
  // touches a plugin). Stable identity: the dialog re-asks per agent, not
  // per render.
  const liveOutside = useCallback(
    (agent: string) => liveOutsideSessions(plugins, agent),
    [plugins],
  );
  if (!controller.ready) return <div className="deck" />;
  const {
    active,
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
    pluginTopBarActions,
    pushAlert,
    railCollapsed,
    railWorkspaces,
    runView,
    browserShared,
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
    openArtifacts,
    openTeamDialog,
    dockControl,
    closeArtifacts,
    openStats,
    closeStats,
    selectStatsTab,
    settings,
    settingsOpen,
    settingsSection,
    showBell,
    showForm,
    skillsOpen,
    artifactsOpen,
    specByPane,
    statsOpen,
    statsTab,
    unavailableReasons,
    updateState,
    usageLiveAgents,
    selectedPaneId,
    keyboardFocusEnabled,
  } = controller;
  // What the update control says and does, or null when there is nothing to
  // say. Derived rather than spelled in the markup: the phase machine is the
  // updater's, and a switch over it belongs somewhere it can be asserted.
  const updateAction = updateActionView(updateState);
  return (
    <div className="deck">
      <DeckBar
        railCollapsed={railCollapsed}
        onToggleRail={() => setRailCollapsed((c) => !c)}
        workspaceName={railCollapsed && active ? active.name : null}
        agents={agents}
        usageLiveAgents={usageLiveAgents}
        updateAction={updateAction}
        onUpdateAction={(action) => {
          if (action.kind === "restart") {
            void restartToUpdate();
          } else {
            openSettings("updates");
          }
        }}
        canAddAgent={canAddAgent}
        addAgentTitle={atCap ? `Max ${MAX_PANES} agents` : "Add agent"}
        onAddAgent={() => {
          if (canAddAgent && active) void agentFlow.openFor(active);
        }}
        onAddTeam={openTeamDialog}
        dock={dockControl}
        pluginActions={pluginTopBarActions}
        canOpenDialog={canOpenDialog}
        onOpenStats={() => void openStats()}
        onOpenSkills={() => void openSkills()}
        onOpenArtifacts={openArtifacts}
        onOpenSettings={() => void openSettings()}
        notifications={
          showBell
            ? { center: notificationCenter, onOpen: openNotification }
            : null
        }
      />
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
            version={info?.version ?? null}
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
            agents={agents}
            agentsReady={!agentsLoading}
            unavailableAgentReasons={unavailableReasons}
            gitHeads={gitHeads}
            journal={deck.journal.records}
            onResumeSession={(wsId, record) =>
              void orchestrator.resumeSession(wsId, record).catch((e: unknown) =>
                pushAlert("Could not resume the session", describeError(e)),
              )
            }
            onForkSession={(wsId, record) => setForkDialog({ wsId, record })}
            browserShared={browserShared}
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
            occupiedPanes={runView.occupied}
            onForkOccupied={(wsId, paneId) => {
              void orchestrator.forkOccupiedSession(wsId, paneId).catch((e: unknown) =>
                pushAlert("Could not fork the session", describeError(e)),
              );
            }}
            onDismissOccupied={orchestrator.dismissOccupied}
            startupPanes={runView.startup}
            onForkStalled={(wsId, paneId) => {
              void orchestrator.forkStalledSession(wsId, paneId).catch((e: unknown) =>
                pushAlert("Could not fork the session", describeError(e)),
              );
            }}
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
              liveOutside={liveOutside}
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
          {artifactsOpen && (
            <ArtifactsDialog
              activeWs={active ? { id: active.id, name: active.name } : null}
              onClose={closeArtifacts}
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
