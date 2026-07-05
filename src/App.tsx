import { useEffect, useState } from "react";
import { DeckStage } from "./components/DeckStage";
import { WorkspacesRail } from "./components/workspace/WorkspacesRail";
import { WorkspaceForm } from "./components/workspace/WorkspaceForm";
import { AgentDialog } from "./components/workspace/AgentDialog";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { fetchAppInfo, openInEditor, type AppInfo } from "./ipc/app";
import { pickFolder } from "./ipc/dialogs";
import { describeError, log } from "./ipc/log";
import { inspectRepo, probeWorktree } from "./ipc/worktree";
import { useAgents } from "./app/useAgents";
import { useDeck } from "./app/useDeck";
import { usePersistence } from "./app/usePersistence";
import { useRevive } from "./app/useRevive";
import { useSessionBinding } from "./app/useSessionBinding";
import { useSettings } from "./app/useSettings";
import { useSpawnContext } from "./app/useSpawnContext";
import { useWorktreeHead } from "./app/useWorktreeHead";
import { paneSpawnSpec } from "./app/spawnSpecs";
import type { SpawnPlan } from "./domain/agents";
import { useProvisioning } from "./app/useProvisioning";
import { useAgentDialog } from "./app/useAgentDialog";
import { dockPanel, dockToggle } from "./domain/run";
import { useCloseFlow } from "./app/useCloseFlow";
import { DockPanel } from "./components/dock/DockPanel";
import { useMenuHotkeys } from "./app/useMenuHotkeys";
import { useDragDrop } from "./app/useDragDrop";
import {
  closeHotkeyTarget,
  DECK_STATE_VERSION,
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
  // Detected agent catalog (labels/commands/install status), fetched from Rust.
  const { agents } = useAgents();
  // Global preferences ([F6]) — loaded before the first paint, saved through.
  const settings = useSettings();
  // Restore the saved deck on boot; save (debounced) on every change ([F7]).
  // `frozen` = the stored deck needs a newer build: session parked, no saves.
  const { restoring, frozen } = usePersistence(deck);
  const [frozenAck, setFrozenAck] = useState(false);
  // Per-install spawn-plan constants (spool dir, reporter activation) — the
  // deck's first paint waits for it ([F7]/[F8] session identity v2).
  const spawnCtx = useSpawnContext();
  // Wake restored panes lazily per workspace — resuming recorded sessions —
  // and report gone directories ([F7]/[F8]).
  const revive = useRevive(deck, agents, spawnCtx);
  // Record session bindings: assigned ids at spawn, reporter postbacks after.
  useSessionBinding(deck);
  // Keep each worktree pane's branch badge live (checkouts inside a worktree).
  useWorktreeHead(deck);
  // The new-workspace form is open (also shown whenever there are no workspaces).
  const [creating, setCreating] = useState(false);
  // Whether the left Workspaces rail is collapsed.
  const [railCollapsed, setRailCollapsed] = useState(false);
  // In-app error notice (no system dialogs).
  const [error, setError] = useState<string | null>(null);
  // The settings dialog ([F6]) — opened from the app menu (⌘,) or the gear.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const provisioning = useProvisioning(deck, agents);
  // "+ Agent" dialog — always shown, to pick the agent type (+ name, and the
  // per-agent worktree location, [F2]).
  const agentFlow = useAgentDialog(deck, agents);
  // A close (agent or workspace) awaiting confirmation ([U6]).
  const closeFlow = useCloseFlow(deck, setError);

  // Drop a file onto a pane → paste its path into that pane's PTY and focus it
  // ([F4]).
  useDragDrop((paneId) => deck.selectPane(deck.activeId, paneId));

  const active = deck.workspaces.find((w) => w.id === deck.activeId) ?? null;
  // The dock (Run panel, experimental) — a persistent side panel like the
  // rail, not a modal. Open/closed is PER workspace (deck.dockByWs), so
  // switching workspaces switches to that workspace's own dock state.
  const dockOpen = deck.dockByWs[deck.activeId] ?? false;
  // The dock's render condition — one named criterion, declared in
  // domain/run; the narrowing to a workspace happens here.
  const dockWs = dockPanel.satisfiedBy({
    settings,
    dockOpen,
    activeWorkspace: active,
  })
    ? active
    : null;
  const showForm = creating || deck.workspaces.length === 0;
  const selectedPaneId = deck.selectByWs[deck.activeId] ?? null;
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
      if (!target) return;
      if (target.kind === "workspace")
        closeFlow.requestCloseWorkspace(target.wsId);
      else
        closeFlow.requestCloseAgent(target.wsId, target.paneId, target.label);
    },
    toggleMaximize: () => {
      if (modalOpen) return;
      const target = maximizeHotkeyTarget(
        deck.workspaces,
        deck.activeId,
        deck.focusByWs,
        deck.selectByWs,
      );
      if (target) deck.toggleFocus(target.wsId, target.paneId);
    },
    openSettings: () => {
      // The create form is a passive surface, not a transaction — settings
      // open over it (on first run the form is the only screen there is, so
      // blocking would make settings unreachable). Its Esc yields while the
      // settings dialog is on top.
      if (dialogOpen || settingsOpen) return;
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
  }));

  // While the saved deck (or the spawn context, or the settings) is loading,
  // paint only the shell background — the boot splash covers this moment;
  // rendering panes before the spawn context arrives would spawn them without
  // their session identity ([F7]/[F8]), and terminals read the scrollback
  // setting at construction ([F6]).
  if (restoring || !spawnCtx || !settings) return <div className="deck" />;

  // Every live pane's spawn plan (cached per pane id — a claude plan mints
  // its session id once). Dormant panes get theirs at revive time; a
  // provisioning pane has no working directory yet, so spawning would drop
  // the agent into the workspace cwd — exactly the fallback the cards
  // replaced.
  const specByPane: Record<string, SpawnPlan> = {};
  for (const ws of deck.workspaces) {
    for (const pane of ws.panes) {
      if (!pane.dormant && !pane.provisioning)
        specByPane[pane.id] = paneSpawnSpec(pane, spawnCtx, agents);
    }
  }

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
          {dockToggle.satisfiedBy({ settings }) && (
            // Every run-preset surface asks domain/run — conditions
            // change there, in one place; live runs keep working regardless.
            <button
              type="button"
              className="bar__icon"
              onClick={() => active && deck.toggleDock(active.id)}
              title={dockOpen ? "Hide the Run panel" : "Show the Run panel"}
              aria-label="Toggle run panel"
            >
              <DockIcon />
            </button>
          )}
          <button
            type="button"
            className="bar__icon"
            onClick={() => setSettingsOpen(true)}
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
            focusByWs={deck.focusByWs}
            selectedPaneId={selectedPaneId}
            agents={agents}
            onStartWorkspace={(wsId, count) =>
              void provisioning.startWorkspace(wsId, count)
            }
            onSelectPane={deck.selectPane}
            onToggleFocus={deck.toggleFocus}
            onOpenInEditor={(path) =>
              void openInEditor(path).catch((e) =>
                log.warn("web:links", `open in editor failed for ${path}: ${describeError(e)}`),
              )
            }
            onCloseAgent={closeFlow.requestCloseAgent}
            onRenamePane={deck.renamePane}
            onPaneTitle={deck.setPaneAutoTitle}
            dormantBlocked={revive.blocked}
            specByPane={specByPane}
            onStartFresh={revive.startFresh}
            onRetryProvision={provisioning.retryPane}
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
            <SettingsDialog onClose={() => setSettingsOpen(false)} />
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
        {dockWs && (
          // Keyed by workspace: switching resets the tab-local state (run
          // target, drafts) to the new workspace's context.
          <DockPanel
            key={dockWs.id}
            ws={dockWs}
            selectedPaneId={selectedPaneId}
            onSetRun={(run) => deck.setWorkspaceRun(dockWs.id, run)}
          />
        )}
      </div>
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
