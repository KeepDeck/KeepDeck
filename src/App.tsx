import { useEffect, useState } from "react";
import { AgentPane } from "./components/agent/AgentPane";
import { WorkspacesRail } from "./components/workspace/WorkspacesRail";
import { WorkspaceSetup } from "./components/workspace/WorkspaceSetup";
import { WorkspaceForm } from "./components/workspace/WorkspaceForm";
import { AgentDialog } from "./components/workspace/AgentDialog";
import { fetchAppInfo, openInEditor, type AppInfo } from "./ipc/app";
import { useAgents } from "./app/useAgents";
import { useDeck } from "./app/useDeck";
import { useProvisioning } from "./app/useProvisioning";
import { useAgentDialog } from "./app/useAgentDialog";
import { useCloseFlow } from "./app/useCloseFlow";
import { useMenuHotkeys } from "./app/useMenuHotkeys";
import { useDragDrop } from "./app/useDragDrop";
import { paneDisplayTitle, resolveFocus } from "./domain/panes";
import { closeHotkeyTarget } from "./domain/hotkeys";
import type { SpawnConfig } from "./domain/workspaces";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { ModalOverlay } from "./ui/ModalOverlay";
import {
  MAX_PANES,
  gridTracks,
  paneColumnSpan,
  paneGrid,
  paneGridTrackColumns,
} from "./domain/layout";
import "./App.css";

/**
 * The composition root: owns only shell-level UI state (rail collapse, the
 * create form, the error notice) and wires the application hooks — deck state,
 * provisioning, the "+ Agent" dialog, the confirmed-close flow, menu hotkeys
 * and file drops — to the components that render them.
 */
function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    fetchAppInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  // The deck's workspaces + active id + per-workspace maximize/selection, in one
  // reducer so close transitions clean focus + selection atomically ([S1], [B2],
  // [L6]).
  const deck = useDeck();
  // Detected agent catalog (labels/commands/install status), fetched from Rust.
  const { agents } = useAgents();
  // The new-workspace form is open (also shown whenever there are no workspaces).
  const [creating, setCreating] = useState(false);
  // Whether the left Workspaces rail is collapsed.
  const [railCollapsed, setRailCollapsed] = useState(false);
  // In-app error notice (no system dialogs).
  const [error, setError] = useState<string | null>(null);

  const provisioning = useProvisioning(deck, agents, setError);
  // "+ Agent" dialog — always shown, to pick the agent type (+ name, and the
  // per-agent worktree location, [F2]).
  const agentFlow = useAgentDialog(deck, agents, setError);
  // A close (agent or workspace) awaiting confirmation ([U6]).
  const closeFlow = useCloseFlow(deck, setError);

  // Drop a file onto a pane → paste its path into that pane's PTY and focus it
  // ([F4]).
  useDragDrop((paneId) => deck.selectPane(deck.activeId, paneId));

  const active = deck.workspaces.find((w) => w.id === deck.activeId) ?? null;
  const showForm = creating || deck.workspaces.length === 0;
  const selectedPaneId = deck.selectByWs[deck.activeId] ?? null;
  const activeCount = active?.panes.length ?? 0;
  const atCap = activeCount >= MAX_PANES;
  const modalOpen =
    showForm ||
    agentFlow.dialog !== null ||
    closeFlow.closing !== null ||
    error !== null;

  // Native-menu hotkeys: ⌘T opens the spawn dialog, ⌘W asks to close the
  // selected pane. A hotkey bypasses both button disabling and the modal
  // overlay, so those guards are mirrored here.
  useMenuHotkeys({
    newAgent: () => {
      if (!active || atCap || modalOpen) return;
      void agentFlow.openFor(active);
    },
    closeAgent: () => {
      if (modalOpen) return;
      const target = closeHotkeyTarget(
        deck.workspaces,
        deck.activeId,
        deck.selectByWs,
        agents,
      );
      if (target)
        closeFlow.requestCloseAgent(target.wsId, target.paneId, target.label);
    },
  });

  const handleSelectWorkspace = (id: string) => {
    deck.selectWorkspace(id);
    // Returning from the create form (you can always go back to an existing one).
    setCreating(false);
  };

  const handleCreateWorkspace = (config: SpawnConfig) => {
    void provisioning.createWorkspace(config).then((created) => {
      if (created) setCreating(false);
    });
  };

  const railWorkspaces = deck.workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    agentCount: w.panes.length,
  }));

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
          <button
            type="button"
            className="bar__action"
            onClick={() => {
              if (active) void agentFlow.openFor(active);
            }}
            disabled={!active || atCap || showForm}
            title={atCap ? `Max ${MAX_PANES} agents` : "Add agent"}
          >
            + Agent
          </button>
          <span className="deck__status">
            {activeCount} {activeCount === 1 ? "pane" : "panes"}
            {info ? ` · ${info.version}` : ""}
          </span>
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
          {deck.workspaces.map((ws) => {
            const isActive = ws.id === deck.activeId;

            if (ws.panes.length === 0) {
              return (
                <div
                  key={ws.id}
                  className="deck__setup"
                  aria-hidden={!isActive}
                  style={{
                    visibility: isActive ? "visible" : "hidden",
                    pointerEvents: isActive ? "auto" : "none",
                  }}
                >
                  <WorkspaceSetup
                    onPick={(count) =>
                      void provisioning.startWorkspace(ws.id, count)
                    }
                  />
                </div>
              );
            }

            const focusedHere = resolveFocus(ws.panes, deck.focusByWs[ws.id]);
            const solo = ws.panes.length === 1;
            const trackColumns = focusedHere
              ? 1
              : paneGridTrackColumns(ws.panes.length);
            const rowCount = focusedHere ? 1 : paneGrid(ws.panes.length).rows;
            return (
              <main
                key={ws.id}
                className={`deck__grid${isActive ? "" : " deck__grid--hidden"}`}
                aria-hidden={!isActive}
                style={{
                  gridTemplateColumns: gridTracks(trackColumns),
                  gridTemplateRows: gridTracks(rowCount),
                }}
              >
                {ws.panes.map((pane, index) => {
                  const isFocused = pane.id === focusedHere;
                  const isCollapsed = focusedHere !== null && !isFocused;
                  const colSpan = focusedHere
                    ? 1
                    : paneColumnSpan(index, ws.panes.length);
                  // Agent command/label are per pane now (not the workspace),
                  // resolved from the fetched catalog ([F1]); fall back to the
                  // id string while the catalog is still loading.
                  const agentType = pane.agentType ?? "claude";
                  const agentInfo = agents.find((a) => a.id === agentType);
                  const command = agentInfo?.command ?? agentType;
                  const displayTitle = paneDisplayTitle(pane, index, agents);
                  return (
                    <AgentPane
                      key={pane.id}
                      paneId={pane.id}
                      title={displayTitle}
                      command={command}
                      cwd={pane.cwd ?? ws.cwd}
                      branch={pane.branch}
                      visible={isActive && !isCollapsed}
                      focused={isFocused}
                      collapsed={isCollapsed}
                      selected={pane.id === selectedPaneId}
                      solo={solo}
                      colSpan={colSpan}
                      onSelect={() => deck.selectPane(ws.id, pane.id)}
                      onToggleFocus={() => deck.toggleFocus(ws.id, pane.id)}
                      onOpenInEditor={() => {
                        void openInEditor(pane.cwd ?? ws.cwd).catch(() => {});
                      }}
                      onClose={() =>
                        closeFlow.requestCloseAgent(ws.id, pane.id, displayTitle)
                      }
                      onRename={(name) => deck.renamePane(ws.id, pane.id, name)}
                      onTitle={(t) => deck.setPaneAutoTitle(ws.id, pane.id, t)}
                    />
                  );
                })}
              </main>
            );
          })}

          {showForm &&
            (deck.workspaces.length > 0 ? (
              // Creating another workspace: a true blocking modal over the deck.
              <ModalOverlay>
                <WorkspaceForm
                  onCreate={handleCreateWorkspace}
                  busy={provisioning.busy}
                  onCancel={() => setCreating(false)}
                />
              </ModalOverlay>
            ) : (
              // First-run: the opaque empty-state setup screen (no cancel — it
              // IS the content, not a dialog over it), kept inside the stage.
              <div className="deck__overlay">
                <WorkspaceForm
                  onCreate={handleCreateWorkspace}
                  busy={provisioning.busy}
                />
              </div>
            ))}

          {agentFlow.dialog && (
            <AgentDialog
              defaultAgentType={agentFlow.dialog.defaultAgentType}
              repo={agentFlow.dialog.repo}
              suggestedPath={agentFlow.dialog.suggestedPath}
              suggestedBranch={agentFlow.dialog.suggestedBranch}
              onConfirm={(result) => void agentFlow.confirm(result)}
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
      </div>
    </div>
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
