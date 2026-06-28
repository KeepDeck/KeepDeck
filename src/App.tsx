import { useEffect, useRef, useState } from "react";
import { AgentPane } from "./agent/AgentPane";
import { WorkspacesRail } from "./workspace/WorkspacesRail";
import { WorkspaceSetup } from "./workspace/WorkspaceSetup";
import { WorkspaceForm, type SpawnConfig } from "./workspace/WorkspaceForm";
import { fetchAppInfo, type AppInfo } from "./ipc";
import { commandForAgent, labelForAgent } from "./agents";
import { makePanes } from "./panes";
import {
  addAgent,
  closeAgent,
  closeWorkspace,
  renameWorkspace,
  resolveActiveId,
  type Workspace,
} from "./workspaces";
import {
  MAX_PANES,
  gridTracks,
  paneColumnSpan,
  paneGrid,
  paneGridTrackColumns,
} from "./layout";
import "./App.css";

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
    setWorkspaces((current) => addAgent(current, activeId, seq));
  };

  const handleCloseAgent = (workspaceId: string, paneId: string) => {
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
  const handleStartWorkspace = (workspaceId: string, count: number) => {
    const startSeq = nextAgentSeq.current;
    nextAgentSeq.current += count;
    const panes = makePanes(startSeq, count);
    setWorkspaces((current) =>
      current.map((w) => (w.id === workspaceId ? { ...w, panes } : w)),
    );
  };

  const handleCreateWorkspace = ({ name, cwd, agentType, count }: SpawnConfig) => {
    const wsSeq = nextWorkspaceSeq.current;
    nextWorkspaceSeq.current += 1;
    const startSeq = nextAgentSeq.current;
    nextAgentSeq.current += count;
    const id = `ws-${wsSeq}`;
    const workspace: Workspace = {
      id,
      name: name.trim() || `workspace-${wsSeq}`,
      cwd,
      agentType,
      panes: makePanes(startSeq, count),
    };
    setWorkspaces((current) => [...current, workspace]);
    setActiveId(id);
    setSelectedPaneId(workspace.panes[0]?.id ?? null);
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
    <div className="cockpit">
      <header className="cockpit__bar">
        <div className="cockpit__bar-left">
          <button
            type="button"
            className="bar__icon"
            onClick={() => setRailCollapsed((c) => !c)}
            title={railCollapsed ? "Show workspaces" : "Hide workspaces"}
            aria-label="Toggle workspaces panel"
          >
            <SidebarIcon />
          </button>
          <span className="cockpit__brand">KeepDeck</span>
        </div>
        <div className="cockpit__bar-right">
          <button
            type="button"
            className="bar__action"
            onClick={handleAddAgent}
            disabled={!active || atCap || showForm}
            title={atCap ? `Max ${MAX_PANES} agents` : "Add agent"}
          >
            + Agent
          </button>
          <span className="cockpit__status">
            {activeCount} {activeCount === 1 ? "pane" : "panes"}
            {info ? ` · ${info.version}` : ""}
          </span>
        </div>
      </header>
      <div className="cockpit__body">
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
        <div className="cockpit__stage">
          {workspaces.map((ws) => {
            const isActive = ws.id === activeId;
            const command = commandForAgent(ws.agentType);
            const label = labelForAgent(ws.agentType);

            if (ws.panes.length === 0) {
              return (
                <div
                  key={ws.id}
                  className="cockpit__setup"
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
                className={`cockpit__grid${isActive ? "" : " cockpit__grid--hidden"}`}
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
                      title={`${label} ${index + 1}`}
                      command={command}
                      cwd={ws.cwd}
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
            <div className="cockpit__overlay">
              <WorkspaceForm
                onCreate={handleCreateWorkspace}
                onCancel={
                  workspaces.length > 0 ? () => setCreating(false) : undefined
                }
              />
            </div>
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
