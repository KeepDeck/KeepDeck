import { useEffect, useRef, useState } from "react";
import { AgentPane } from "./agent/AgentPane";
import { WorkspacesRail } from "./workspace/WorkspacesRail";
import { WorkspaceSetup } from "./workspace/WorkspaceSetup";
import { WorkspaceForm, type SpawnConfig } from "./workspace/WorkspaceForm";
import { AgentDialog, type AgentDialogResult } from "./workspace/AgentDialog";
import { fetchAppInfo, type AppInfo } from "./ipc";
import { commandForAgent, labelForAgent } from "./agents";
import { makePanes, type Pane } from "./panes";
import {
  addAgent,
  addAgentPane,
  closeAgent,
  closeWorkspace,
  renameWorkspace,
  resolveActiveId,
  type Workspace,
} from "./workspaces";
import { createWorktree, inspectRepo, removeWorktree } from "./worktree";
import {
  MAX_PANES,
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
): Promise<Pane[]> {
  if (!ws.worktreeBaseDir) return makePanes(startSeq, count);

  let base: string | undefined;
  try {
    base = (await inspectRepo(ws.cwd)).head ?? undefined;
  } catch {
    base = undefined; // create resolves HEAD itself when base is omitted
  }

  const n = Math.max(0, Math.min(count, MAX_PANES));
  const panes: Pane[] = [];
  for (let i = 0; i < n; i++) {
    const agentId = `pane-${startSeq + i}`;
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
      window.alert(`Failed to create worktree for ${agentId}:\n${e}`);
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
  // The pane with the highlight border (last interacted-with in the active ws).
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  // The new-workspace form is open (also shown whenever there are no workspaces).
  const [creating, setCreating] = useState(false);
  // Whether the left Workspaces rail is collapsed.
  const [railCollapsed, setRailCollapsed] = useState(false);
  const nextAgentSeq = useRef(1);
  const nextWorkspaceSeq = useRef(1);
  // Open "+ Agent" dialog (worktree mode only): predicted path + default branch.
  const [agentDialog, setAgentDialog] = useState<{
    wsId: string;
    agentId: string;
    index: number;
    defaultBranch: string;
    worktreePath: string;
  } | null>(null);

  const active = workspaces.find((w) => w.id === activeId) ?? null;
  const showForm = creating || workspaces.length === 0;

  const handleSelectWorkspace = (id: string) => {
    setActiveId(id);
    // Selecting a workspace returns from the create form (you can always go back
    // to an existing one).
    setCreating(false);
    const ws = workspaces.find((w) => w.id === id);
    setSelectedPaneId(ws?.panes[0]?.id ?? null);
  };

  const handleAddAgent = () => {
    if (!active) return;
    const seq = nextAgentSeq.current;
    nextAgentSeq.current += 1;
    // Worktree mode: open the dialog to pick a branch/name + see the path first.
    if (active.worktreeBaseDir) {
      const agentId = `pane-${seq}`;
      const index = active.panes.length + 1;
      const slug = active.name.trim().replace(/\s+/g, "-") || "ws";
      setAgentDialog({
        wsId: active.id,
        agentId,
        index,
        defaultBranch: `kd/${slug}/${index}`,
        worktreePath: `${active.worktreeBaseDir}/${agentId}`,
      });
      return;
    }
    setWorkspaces((current) => addAgent(current, activeId, seq));
  };

  const handleConfirmAgent = async ({ name, branch }: AgentDialogResult) => {
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
      });
      const pane: Pane = {
        id: dlg.agentId,
        cwd: rec.path,
        branch: rec.branch,
        name: name.trim() || undefined,
      };
      setWorkspaces((current) => addAgentPane(current, dlg.wsId, pane));
      setSelectedPaneId(dlg.agentId);
    } catch (e) {
      console.error("worktree create failed", e);
      window.alert(`Failed to create agent worktree:\n${e}`);
    }
  };

  const handleCloseAgent = (workspaceId: string, paneId: string) => {
    const ws = workspaces.find((w) => w.id === workspaceId);
    const pane = ws?.panes.find((p) => p.id === paneId);
    if (ws?.worktreeBaseDir && pane?.cwd) {
      // Best-effort: remove a clean worktree; the backend refuses a dirty one,
      // which we keep (park) on disk so work is never destroyed.
      removeWorktree(ws.cwd, pane.cwd).catch((e) =>
        console.warn("worktree kept:", e),
      );
    }
    setWorkspaces((current) => closeAgent(current, workspaceId, paneId));
    setFocusByWs((cur) => {
      if (cur[workspaceId] !== paneId) return cur;
      const next = { ...cur };
      delete next[workspaceId];
      return next;
    });
    setSelectedPaneId((cur) => {
      if (cur !== paneId) return cur;
      const ws = workspaces.find((w) => w.id === workspaceId);
      const remaining = ws?.panes.filter((p) => p.id !== paneId) ?? [];
      return remaining[0]?.id ?? null;
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
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    const startSeq = nextAgentSeq.current;
    nextAgentSeq.current += count;
    const panes = await provisionPanes(ws, startSeq, count);
    setWorkspaces((current) =>
      current.map((w) => (w.id === workspaceId ? { ...w, panes } : w)),
    );
    setSelectedPaneId(panes[0]?.id ?? null);
  };

  const handleCreateWorkspace = async ({
    name,
    cwd,
    agentType,
    count,
    worktreeBaseDir,
  }: SpawnConfig) => {
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
    setSelectedPaneId(panes[0]?.id ?? null);
    setCreating(false);
  };

  const handleRenameWorkspace = (id: string, name: string) =>
    setWorkspaces((current) => renameWorkspace(current, id, name));

  const handleCloseWorkspace = (id: string) => {
    const next = closeWorkspace(workspaces, id);
    setWorkspaces(next);
    setActiveId(resolveActiveId(next, activeId));
    setFocusByWs((cur) => {
      if (!(id in cur)) return cur;
      const updated = { ...cur };
      delete updated[id];
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
                      onSelect={() => setSelectedPaneId(pane.id)}
                      onToggleFocus={() => toggleFocus(ws.id, pane.id)}
                      onClose={() => handleCloseAgent(ws.id, pane.id)}
                    />
                  );
                })}
              </main>
            );
          })}

          {showForm && (
            <div className="deck__overlay">
              <WorkspaceForm
                onCreate={handleCreateWorkspace}
                onCancel={
                  workspaces.length > 0 ? () => setCreating(false) : undefined
                }
              />
            </div>
          )}

          {agentDialog && (
            <AgentDialog
              defaultBranch={agentDialog.defaultBranch}
              worktreePath={agentDialog.worktreePath}
              onConfirm={handleConfirmAgent}
              onCancel={() => setAgentDialog(null)}
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
