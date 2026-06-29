import { useEffect, useRef, useState } from "react";
import { AgentPane } from "./agent/AgentPane";
import { WorkspacesRail } from "./workspace/WorkspacesRail";
import { WorkspaceSetup } from "./workspace/WorkspaceSetup";
import { WorkspaceForm, type SpawnConfig } from "./workspace/WorkspaceForm";
import { AgentDialog, type AgentDialogResult } from "./workspace/AgentDialog";
import { fetchAppInfo, type AppInfo } from "./ipc";
import { commandForAgent, labelForAgent } from "./agents";
import { makePanes, paneId, type Pane } from "./panes";
import {
  addAgent,
  addAgentPane,
  closeAgent,
  closeWorkspace,
  renameWorkspace,
  resolveActiveId,
  type Workspace,
} from "./workspaces";
import { createWorktree, inspectRepo, suggestWorktree } from "./worktree";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import {
  MAX_PANES,
  clampPaneCount,
  gridTracks,
  paneColumnSpan,
  paneGrid,
  paneGridTrackColumns,
} from "./layout";
import "./App.css";

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
  onError: (message: string) => void,
): Promise<Pane[]> {
  if (!ws.worktreeBaseDir) return makePanes(startSeq, count);

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
      panes.push({ id: agentId, cwd: rec.path, branch: rec.branch });
    } catch (e) {
      console.error("worktree create failed", e);
      onError(`Failed to create worktree for ${agentId}:\n${e}`);
      panes.push({ id: agentId }); // fall back to the workspace cwd
    }
  }
  return panes;
}

function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    fetchAppInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState("");
  const [focusByWs, setFocusByWs] = useState<Record<string, string>>({});
  // The highlighted pane PER workspace, so switching keeps the one you were on
  // instead of resetting to the first ([B2]) and closing a workspace can't leave
  // the border on a deleted pane ([L6]).
  const [selectByWs, setSelectByWs] = useState<Record<string, string>>({});
  // The new-workspace form is open (also shown whenever there are no workspaces).
  const [creating, setCreating] = useState(false);
  // Whether the left Workspaces rail is collapsed.
  const [railCollapsed, setRailCollapsed] = useState(false);
  const nextAgentSeq = useRef(1);
  const nextWorkspaceSeq = useRef(1);
  // Hard reentrancy guard for the async provision handlers — a ref is
  // synchronous, so a second click during the await can't double-provision (a
  // state flag would race). `busy` is the render-time mirror to disable the UI.
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  // Open "+ Agent" dialog (worktree mode only): predicted path + default branch.
  const [agentDialog, setAgentDialog] = useState<{
    wsId: string;
    agentId: string;
    index: number;
    defaultBranch: string;
    defaultFolder: string;
  } | null>(null);
  // In-app error notice (no system dialogs).
  const [error, setError] = useState<string | null>(null);

  const active = workspaces.find((w) => w.id === activeId) ?? null;
  const showForm = creating || workspaces.length === 0;
  const selectedPaneId = selectByWs[activeId] ?? null;
  const selectPane = (wsId: string, paneId: string) =>
    setSelectByWs((cur) => ({ ...cur, [wsId]: paneId }));

  const handleSelectWorkspace = (id: string) => {
    setActiveId(id);
    // Selecting a workspace returns from the create form (you can always go back
    // to an existing one).
    setCreating(false);
    // Default to the first pane only if this workspace has no selection yet.
    const ws = workspaces.find((w) => w.id === id);
    setSelectByWs((cur) =>
      cur[id] || !ws?.panes[0] ? cur : { ...cur, [id]: ws.panes[0].id },
    );
  };

  const handleAddAgent = async () => {
    if (!active) return;
    const seq = nextAgentSeq.current;
    nextAgentSeq.current += 1;
    // Worktree mode: open the dialog to pick a branch/folder/name first. The
    // defaults come from the backend (single source of branch/folder naming).
    if (active.worktreeBaseDir) {
      const index = active.panes.length + 1;
      const suggestion = await suggestWorktree(active.name, index);
      setAgentDialog({
        wsId: active.id,
        agentId: paneId(seq),
        index,
        defaultBranch: suggestion.branch,
        defaultFolder: suggestion.folder,
      });
      return;
    }
    setWorkspaces((current) => addAgent(current, activeId, seq));
  };

  const handleConfirmAgent = async ({
    name,
    branch,
    folder,
  }: AgentDialogResult) => {
    const dlg = agentDialog;
    if (!dlg) return;
    setAgentDialog(null);
    const ws = workspaces.find((w) => w.id === dlg.wsId);
    if (!ws || !ws.worktreeBaseDir) return;
    try {
      const base = (await inspectRepo(ws.cwd).catch(() => null))?.head ?? undefined;
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
      const pane: Pane = {
        id: dlg.agentId,
        cwd: rec.path,
        branch: rec.branch,
        name: name.trim() || undefined,
      };
      setWorkspaces((current) => addAgentPane(current, dlg.wsId, pane));
      selectPane(dlg.wsId, dlg.agentId);
    } catch (e) {
      console.error("worktree create failed", e);
      setError(`Failed to create agent worktree:\n${e}`);
    }
  };

  const handleCloseAgent = (workspaceId: string, paneId: string) => {
    // Closing an agent removes its pane (tearing down the PTY). Its git worktree
    // and branch are left on disk — cleanup is deferred (see worktrees design).
    setWorkspaces((current) => closeAgent(current, workspaceId, paneId));
    setFocusByWs((cur) => {
      if (cur[workspaceId] !== paneId) return cur;
      const next = { ...cur };
      delete next[workspaceId];
      return next;
    });
    setSelectByWs((cur) => {
      if (cur[workspaceId] !== paneId) return cur;
      const ws = workspaces.find((w) => w.id === workspaceId);
      const remaining = ws?.panes.filter((p) => p.id !== paneId) ?? [];
      const next = { ...cur };
      if (remaining[0]) next[workspaceId] = remaining[0].id;
      else delete next[workspaceId];
      return next;
    });
  };

  const toggleFocus = (workspaceId: string, paneId: string) =>
    setFocusByWs((cur) => {
      const next = { ...cur };
      if (next[workspaceId] === paneId) delete next[workspaceId];
      else next[workspaceId] = paneId;
      return next;
    });

  // Add `count` agents to an existing (empty) workspace.
  const handleStartWorkspace = async (workspaceId: string, count: number) => {
    if (submitting.current) return;
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    submitting.current = true;
    setBusy(true);
    try {
      const startSeq = nextAgentSeq.current;
      nextAgentSeq.current += count;
      const panes = await provisionPanes(ws, startSeq, count, setError);
      setWorkspaces((current) =>
        current.map((w) => (w.id === workspaceId ? { ...w, panes } : w)),
      );
      if (panes[0]) selectPane(workspaceId, panes[0].id);
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
        setError,
      );
      const workspace: Workspace = {
        id,
        name: wsName,
        cwd,
        agentType,
        worktreeBaseDir,
        panes,
      };
      setWorkspaces((current) => [...current, workspace]);
      setActiveId(id);
      if (panes[0]) selectPane(id, panes[0].id);
      setCreating(false);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const handleRenameWorkspace = (id: string, name: string) =>
    setWorkspaces((current) => renameWorkspace(current, id, name));

  const handleCloseWorkspace = (id: string) => {
    const next = closeWorkspace(workspaces, id);
    const newActive = resolveActiveId(next, activeId);
    setWorkspaces(next);
    setActiveId(newActive);
    setFocusByWs((cur) => {
      if (!(id in cur)) return cur;
      const updated = { ...cur };
      delete updated[id];
      return updated;
    });
    // Drop the closed workspace's selection; default the new active one's so the
    // border lands on a live pane, not the deleted workspace's ([L6]).
    setSelectByWs((cur) => {
      const updated = { ...cur };
      delete updated[id];
      const aws = next.find((w) => w.id === newActive);
      if (newActive && !updated[newActive] && aws?.panes[0]) {
        updated[newActive] = aws.panes[0].id;
      }
      return updated;
    });
  };

  const railWorkspaces = workspaces.map((w) => ({
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
            activeId={activeId}
            onSelect={handleSelectWorkspace}
            onAdd={() => setCreating(true)}
            onClose={handleCloseWorkspace}
            onRename={handleRenameWorkspace}
          />
        )}
        <div className="deck__stage">
          {workspaces.map((ws) => {
            const isActive = ws.id === activeId;
            const command = commandForAgent(ws.agentType);
            const label = labelForAgent(ws.agentType);

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

            const focusedPaneId = focusByWs[ws.id];
            const focusedHere =
              focusedPaneId && ws.panes.some((p) => p.id === focusedPaneId)
                ? focusedPaneId
                : null;
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
                  return (
                    <AgentPane
                      key={pane.id}
                      title={pane.name ?? `${label} ${index + 1}`}
                      command={command}
                      cwd={pane.cwd ?? ws.cwd}
                      branch={pane.branch}
                      visible={isActive && !isCollapsed}
                      focused={isFocused}
                      collapsed={isCollapsed}
                      selected={pane.id === selectedPaneId}
                      colSpan={colSpan}
                      onSelect={() => selectPane(ws.id, pane.id)}
                      onToggleFocus={() => toggleFocus(ws.id, pane.id)}
                      onClose={() => handleCloseAgent(ws.id, pane.id)}
                    />
                  );
                })}
              </main>
            );
          })}

          {showForm && (
            <div
              className={
                workspaces.length > 0 ? "modal-overlay" : "deck__overlay"
              }
            >
              <WorkspaceForm
                onCreate={handleCreateWorkspace}
                busy={busy}
                onCancel={
                  workspaces.length > 0 ? () => setCreating(false) : undefined
                }
              />
            </div>
          )}

          {agentDialog && (
            <AgentDialog
              defaultBranch={agentDialog.defaultBranch}
              defaultFolder={agentDialog.defaultFolder}
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
