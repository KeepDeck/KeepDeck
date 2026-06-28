import { useEffect, useRef, useState } from "react";
import { AgentPane } from "./agent/AgentPane";
import { WorkspacesRail } from "./workspace/WorkspacesRail";
import { fetchAppInfo, type AppInfo } from "./ipc";
import {
  addAgent,
  addWorkspace,
  closeAgent,
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

  const [workspaces, setWorkspaces] = useState<Workspace[]>([
    { id: "default", name: "default", panes: [{ id: "pane-1", title: "agent-1" }] },
  ]);
  const [activeId, setActiveId] = useState("default");
  const nextAgentSeq = useRef(2);
  const nextWorkspaceSeq = useRef(1);

  const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0];

  const handleAddAgent = () => {
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

  const railWorkspaces = workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    agentCount: w.panes.length,
  }));
  const atCap = (active?.panes.length ?? 0) >= MAX_PANES;
  const activeCount = active?.panes.length ?? 0;

  return (
    <div className="cockpit">
      <header className="cockpit__bar">
        <span className="cockpit__brand">KeepDeck</span>
        <div className="cockpit__bar-right">
          <button
            type="button"
            className="bar__action"
            onClick={handleAddAgent}
            disabled={atCap}
            title={atCap ? `Max ${MAX_PANES} agents` : "Add agent"}
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
