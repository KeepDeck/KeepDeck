import { useEffect, useRef, useState } from "react";
import { AgentPane } from "./agent/AgentPane";
import { WorkspacesRail } from "./workspace/WorkspacesRail";
import { fetchAppInfo, type AppInfo } from "./ipc";
import {
  addAgent,
  addWorkspace,
  closeAgent,
  closeWorkspace,
  resolveActiveId,
  type Workspace,
} from "./workspaces";
import { MAX_PANES, gridTracks, paneGrid } from "./layout";
import "./App.css";

function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    fetchAppInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  // Start empty — no workspace, no session — until the user creates one.
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState("");
  const nextAgentSeq = useRef(1);
  const nextWorkspaceSeq = useRef(1);

  const active = workspaces.find((w) => w.id === activeId) ?? null;

  const handleAddAgent = () => {
    if (!active) return;
    const seq = nextAgentSeq.current;
    nextAgentSeq.current += 1;
    setWorkspaces((current) => addAgent(current, activeId, seq));
  };

  const handleCloseAgent = (workspaceId: string, paneId: string) =>
    setWorkspaces((current) => closeAgent(current, workspaceId, paneId));

  const handleAddWorkspace = () => {
    const seq = nextWorkspaceSeq.current;
    nextWorkspaceSeq.current += 1;
    const id = `ws-${seq}`;
    setWorkspaces((current) => addWorkspace(current, seq));
    setActiveId(id);
  };

  const handleCloseWorkspace = (id: string) => {
    // Removing the workspace unmounts its panes, which tears down their PTY
    // sessions (no leaks).
    const next = closeWorkspace(workspaces, id);
    setWorkspaces(next);
    setActiveId(resolveActiveId(next, activeId));
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
        <span className="cockpit__brand">KeepDeck</span>
        <div className="cockpit__bar-right">
          <button
            type="button"
            className="bar__action"
            onClick={handleAddAgent}
            disabled={!active || atCap}
            title={
              !active
                ? "Create a workspace first"
                : atCap
                  ? `Max ${MAX_PANES} agents`
                  : "Add agent"
            }
          >
            + Agent
          </button>
          <span className="cockpit__status">
            {activeCount} {activeCount === 1 ? "pane" : "panes"}
            {info ? ` · core ${info.version}` : ""}
          </span>
        </div>
      </header>
      <div className="cockpit__body">
        <WorkspacesRail
          workspaces={railWorkspaces}
          activeId={activeId}
          onSelect={setActiveId}
          onAdd={handleAddWorkspace}
          onClose={handleCloseWorkspace}
        />
        {/* Every workspace's grid stays mounted (sessions keep running); only
            the active one is visible. */}
        <div className="cockpit__stage">
          {workspaces.map((ws) => {
            const grid = paneGrid(Math.max(ws.panes.length, 1));
            const isActive = ws.id === activeId;
            return (
              <main
                key={ws.id}
                className={`cockpit__grid${isActive ? "" : " cockpit__grid--hidden"}`}
                aria-hidden={!isActive}
                style={{
                  gridTemplateColumns: gridTracks(grid.columns),
                  gridTemplateRows: gridTracks(grid.rows),
                }}
              >
                {ws.panes.map((pane) => (
                  <AgentPane
                    key={pane.id}
                    title={pane.title}
                    active={isActive}
                    onClose={() => handleCloseAgent(ws.id, pane.id)}
                  />
                ))}
              </main>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default App;
