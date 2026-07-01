import { useEffect, useRef, useState } from "react";
import { AgentPane } from "./agent/AgentPane";
import { WorkspacesRail } from "./workspace/WorkspacesRail";
import { WorkspaceSetup } from "./workspace/WorkspaceSetup";
import { WorkspaceForm, type SpawnConfig } from "./workspace/WorkspaceForm";
import { AgentDialog, type AgentDialogResult } from "./workspace/AgentDialog";
import { fetchAppInfo, openInEditor, pathsAreImages, type AppInfo } from "./ipc";
import { defaultAgentType, useAgents, type AgentType } from "./agents";
import { makePanes, paneId, resolveFocus, type Pane } from "./panes";
import {
  worktreeTargets,
  type Workspace,
  type WorktreeTarget,
} from "./workspaces";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useDeck } from "./deck";
import {
  createWorktree,
  inspectRepo,
  removeWorktree,
  suggestWorktree,
} from "./worktree";
import { collectPaneRects, deliverDrop, paneAtPoint } from "./terminal/dnd";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { ModalOverlay } from "./ui/ModalOverlay";
import {
  MAX_PANES,
  clampPaneCount,
  gridTracks,
  paneColumnSpan,
  paneGrid,
  paneGridTrackColumns,
} from "./layout";
import "./App.css";

/** A pending close awaiting confirmation ([U6]) — an agent pane or a whole
 * workspace. Closing tears down live PTY session(s) immediately, so both are
 * confirmed before they run. `targets` is the worktrees the close could also
 * delete (empty in non-worktree mode), snapshotted at open time — the modal
 * blocks all mutation, so it can't go stale. */
type ClosingTarget = { targets: WorktreeTarget[] } & (
  | { kind: "agent"; wsId: string; paneId: string; label: string }
  | { kind: "workspace"; id: string; name: string; count: number }
);

/**
 * Build `count` panes for a workspace. In worktree mode each agent gets its own
 * git worktree, all pinned to one base commit (resolved once) so a concurrent
 * batch starts from the same state; otherwise plain panes that run in the cwd.
 * A per-agent create failure falls back to a cwd pane so the batch still lands.
 */
async function provisionPanes(
  ws: { cwd: string; worktreeBaseDir: string | null; name: string },
  startSeq: number,
  count: number,
  agentType: AgentType,
  onError: (message: string) => void,
): Promise<Pane[]> {
  if (!ws.worktreeBaseDir) return makePanes(startSeq, count, agentType);

  let base: string | undefined;
  try {
    base = (await inspectRepo(ws.cwd)).head ?? undefined;
  } catch {
    base = undefined; // create resolves HEAD itself when base is omitted
  }

  const n = clampPaneCount(count);
  const panes: Pane[] = [];
  for (let i = 0; i < n; i++) {
    const agentId = paneId(startSeq + i);
    try {
      const rec = await createWorktree({
        repo: ws.cwd,
        baseDir: ws.worktreeBaseDir,
        agentId,
        base,
        workspace: ws.name,
        index: i + 1,
      });
      panes.push({ id: agentId, cwd: rec.path, branch: rec.branch, agentType });
    } catch (e) {
      console.error("worktree create failed", e);
      onError(`Failed to create worktree for ${agentId}:\n${e}`);
      panes.push({ id: agentId, agentType }); // fall back to the workspace cwd
    }
  }
  return panes;
}

/**
 * Tear down each target's git worktree and branch when the close dialog's delete
 * checkbox was ticked. Always forced — the checkbox is explicit intent, so a
 * dirty worktree / unmerged branch is discarded per the user's decision. Never
 * throws: a failing target is collected so one bad worktree doesn't strand the
 * rest, and the messages surface in the error dialog.
 */
async function discardWorktrees(targets: WorktreeTarget[]): Promise<string[]> {
  const failures: string[] = [];
  for (const t of targets) {
    try {
      await removeWorktree(t.repo, t.path, { force: true, branch: t.branch });
    } catch (e) {
      failures.push(`${t.branch}: ${e}`);
    }
  }
  return failures;
}

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

  // Latest deck handles for the mount-once drag-drop effect to read without
  // re-subscribing the Tauri listener on every render.
  const selectPaneRef = useRef(deck.selectPane);
  selectPaneRef.current = deck.selectPane;
  const activeIdRef = useRef(deck.activeId);
  activeIdRef.current = deck.activeId;

  // Drop a file onto a pane → paste its path into that pane's PTY and focus it
  // ([F4]). OS file drops in a Tauri webview do NOT fire DOM drag events — only
  // Tauri's onDragDropEvent, whose position is already in viewport CSS pixels,
  // so we match it against each active-grid pane's getBoundingClientRect to find
  // the pane under the cursor. The drop can fire twice (tauri#14134) so we
  // debounce; the cancelled flag keeps a StrictMode double-mount from leaving
  // two listeners.
  useEffect(() => {
    // Kill the WKWebView's native "insert dropped text into the focused field"
    // behaviour. For OS file drops it doesn't surface as a DOM drop event, but
    // it DOES fire a beforeinput with inputType 'insertFromDrop' on the focused
    // xterm textarea — that second copy landed in the focused pane. Cancel it
    // (capture) so only our routed insertion remains.
    const blockDropInsert = (e: Event) => {
      if ((e as InputEvent).inputType === "insertFromDrop") {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    document.addEventListener("beforeinput", blockDropInsert, true);

    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let lastDropAt = 0;

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop" || event.payload.paths.length === 0)
          return;
        const now = Date.now();
        if (now - lastDropAt < 400) return; // collapse Tauri's duplicate drop
        lastDropAt = now;
        const { x, y } = event.payload.position;
        const id = paneAtPoint(x, y, collectPaneRects());
        if (!id) return;
        const { paths } = event.payload;
        // The backend says which paths are images (by content) so images get
        // bracketed-pasted for the agent to attach, others inserted raw.
        const isImage = await pathsAreImages(paths).catch(() =>
          paths.map(() => false),
        );
        if (deliverDrop(id, paths, isImage)) {
          // Make the dropped pane active so you can act on it immediately.
          selectPaneRef.current(activeIdRef.current, id);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      document.removeEventListener("beforeinput", blockDropInsert, true);
      unlisten?.();
    };
  }, []);
  // The new-workspace form is open (also shown whenever there are no workspaces).
  const [creating, setCreating] = useState(false);
  // Whether the left Workspaces rail is collapsed.
  const [railCollapsed, setRailCollapsed] = useState(false);
  // Detected agent catalog (labels/commands/install status), fetched from Rust.
  const { agents } = useAgents();
  const nextAgentSeq = useRef(1);
  const nextWorkspaceSeq = useRef(1);
  // Hard reentrancy guard for the async provision handlers — a ref is
  // synchronous, so a second click during the await can't double-provision (a
  // state flag would race). `busy` is the render-time mirror to disable the UI.
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  // "+ Agent" dialog — always shown, to pick the agent type (+ name, and
  // branch/folder in worktree mode).
  const [agentDialog, setAgentDialog] = useState<{
    wsId: string;
    agentId: string;
    index: number;
    defaultAgentType: AgentType;
    worktree?: { defaultBranch: string; defaultFolder: string };
  } | null>(null);
  // In-app error notice (no system dialogs).
  const [error, setError] = useState<string | null>(null);
  // A close (agent or workspace) awaiting confirmation ([U6]).
  const [closing, setClosing] = useState<ClosingTarget | null>(null);
  // Opt-in: also delete the closing target's worktree(s) + branch(es). Reset
  // each time the dialog opens so the destructive choice is never sticky.
  const [deleteWorktree, setDeleteWorktree] = useState(false);

  const active = deck.workspaces.find((w) => w.id === deck.activeId) ?? null;
  const showForm = creating || deck.workspaces.length === 0;
  const selectedPaneId = deck.selectByWs[deck.activeId] ?? null;

  const handleSelectWorkspace = (id: string) => {
    deck.selectWorkspace(id);
    // Returning from the create form (you can always go back to an existing one).
    setCreating(false);
  };

  const handleAddAgent = async () => {
    if (!active) return;
    const seq = nextAgentSeq.current;
    nextAgentSeq.current += 1;
    const index = active.panes.length + 1;
    // Default the type to the last pane's if it's still selectable, else the
    // first installed agent ([F1]).
    const defaultType = defaultAgentType(
      agents,
      active.panes[active.panes.length - 1]?.agentType,
    );
    // Worktree mode also prefills branch/folder from the backend.
    const worktree = active.worktreeBaseDir
      ? await suggestWorktree(active.name, index).then((s) => ({
          defaultBranch: s.branch,
          defaultFolder: s.folder,
        }))
      : undefined;
    setAgentDialog({
      wsId: active.id,
      agentId: paneId(seq),
      index,
      defaultAgentType: defaultType,
      worktree,
    });
  };

  const handleConfirmAgent = async ({
    agentType,
    name,
    branch,
    folder,
  }: AgentDialogResult) => {
    const dlg = agentDialog;
    if (!dlg) return;
    setAgentDialog(null);
    const ws = deck.workspaces.find((w) => w.id === dlg.wsId);
    if (!ws) return;
    const paneName = name.trim() || undefined;
    // Non-worktree: a bare pane that runs in the workspace cwd.
    if (!ws.worktreeBaseDir || !branch || !folder) {
      deck.addAgentPane(dlg.wsId, { id: dlg.agentId, name: paneName, agentType });
      return;
    }
    try {
      const base =
        (await inspectRepo(ws.cwd).catch(() => null))?.head ?? undefined;
      const rec = await createWorktree({
        repo: ws.cwd,
        baseDir: ws.worktreeBaseDir,
        agentId: dlg.agentId,
        branch,
        base,
        workspace: ws.name,
        index: dlg.index,
        dir: folder,
      });
      deck.addAgentPane(dlg.wsId, {
        id: dlg.agentId,
        cwd: rec.path,
        branch: rec.branch,
        name: paneName,
        agentType,
      });
    } catch (e) {
      console.error("worktree create failed", e);
      setError(`Failed to create agent worktree:\n${e}`);
    }
  };

  // Add `count` agents to an existing (empty) workspace.
  const handleStartWorkspace = async (workspaceId: string, count: number) => {
    if (submitting.current) return;
    const ws = deck.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    submitting.current = true;
    setBusy(true);
    try {
      const startSeq = nextAgentSeq.current;
      nextAgentSeq.current += count;
      const panes = await provisionPanes(
        ws,
        startSeq,
        count,
        defaultAgentType(agents),
        setError,
      );
      deck.setPanes(workspaceId, panes);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const handleCreateWorkspace = async ({
    name,
    cwd,
    agentType,
    count,
    worktreeBaseDir,
  }: SpawnConfig) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      const wsSeq = nextWorkspaceSeq.current;
      nextWorkspaceSeq.current += 1;
      const startSeq = nextAgentSeq.current;
      nextAgentSeq.current += count;
      const id = `ws-${wsSeq}`;
      const wsName = name.trim() || `workspace-${wsSeq}`;
      const panes = await provisionPanes(
        { cwd, worktreeBaseDir, name: wsName },
        startSeq,
        count,
        agentType,
        setError,
      );
      const workspace: Workspace = {
        id,
        name: wsName,
        cwd,
        worktreeBaseDir,
        panes,
      };
      deck.createWorkspace(workspace);
      setCreating(false);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  // Ask before closing — both close paths run through a confirm dialog ([U6]).
  // Worktrees to potentially delete are snapshotted now (workspace still here).
  const requestCloseAgent = (wsId: string, paneId: string, label: string) => {
    const ws = deck.workspaces.find((w) => w.id === wsId);
    setDeleteWorktree(false);
    setClosing({
      kind: "agent",
      wsId,
      paneId,
      label,
      targets: ws ? worktreeTargets(ws, paneId) : [],
    });
  };
  const requestCloseWorkspace = (id: string) => {
    const ws = deck.workspaces.find((w) => w.id === id);
    if (!ws) return;
    setDeleteWorktree(false);
    setClosing({
      kind: "workspace",
      id,
      name: ws.name,
      count: ws.panes.length,
      targets: worktreeTargets(ws),
    });
  };
  const confirmClose = () => {
    if (!closing) return;
    const targets = deleteWorktree ? closing.targets : [];
    // Close in the UI first: unmounting the pane(s) ends their PTY sessions, so
    // the worktree dirs are no longer a live process cwd when we remove them.
    if (closing.kind === "agent") deck.closeAgent(closing.wsId, closing.paneId);
    else deck.closeWorkspace(closing.id);
    setClosing(null);
    setDeleteWorktree(false);
    if (targets.length > 0) {
      void discardWorktrees(targets).then((failures) => {
        if (failures.length > 0)
          setError(
            `Failed to delete worktree${failures.length === 1 ? "" : "s"}:\n${failures.join("\n")}`,
          );
      });
    }
  };

  const railWorkspaces = deck.workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    agentCount: w.panes.length,
  }));
  const activeCount = active?.panes.length ?? 0;
  const atCap = activeCount >= MAX_PANES;

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
            onClick={handleAddAgent}
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
            onClose={requestCloseWorkspace}
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
                    onPick={(count) => handleStartWorkspace(ws.id, count)}
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
                  const info = agents.find((a) => a.id === agentType);
                  const command = info?.command ?? agentType;
                  // Manual name wins, then the auto title, then the derived
                  // "<Agent> N" ([F11]).
                  const displayTitle =
                    pane.name ??
                    pane.autoTitle ??
                    `${info?.label ?? agentType} ${index + 1}`;
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
                        requestCloseAgent(ws.id, pane.id, displayTitle)
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
                  busy={busy}
                  onCancel={() => setCreating(false)}
                />
              </ModalOverlay>
            ) : (
              // First-run: the opaque empty-state setup screen (no cancel — it
              // IS the content, not a dialog over it), kept inside the stage.
              <div className="deck__overlay">
                <WorkspaceForm onCreate={handleCreateWorkspace} busy={busy} />
              </div>
            ))}

          {agentDialog && (
            <AgentDialog
              defaultAgentType={agentDialog.defaultAgentType}
              worktree={agentDialog.worktree}
              onConfirm={handleConfirmAgent}
              onCancel={() => setAgentDialog(null)}
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

          {closing && (
            <ConfirmDialog
              title={
                closing.kind === "agent"
                  ? `Close agent "${closing.label}"?`
                  : `Close workspace "${closing.name}"?`
              }
              message={
                closing.kind === "agent"
                  ? "Its terminal session will be ended."
                  : closing.count === 0
                    ? "This workspace has no agents."
                    : `This ends ${closing.count} agent${closing.count === 1 ? "" : "s"} and their sessions.`
              }
              confirmLabel="Close"
              cancelLabel="Cancel"
              destructive
              onConfirm={confirmClose}
              onCancel={() => setClosing(null)}
            >
              {closing.targets.length > 0 && (
                <label className="confirm__option">
                  <input
                    type="checkbox"
                    checked={deleteWorktree}
                    onChange={(e) => setDeleteWorktree(e.target.checked)}
                  />
                  <span className="confirm__option-text">
                    {closing.targets.length === 1
                      ? "Also delete the worktree and branch"
                      : `Also delete all ${closing.targets.length} worktrees and branches`}
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
