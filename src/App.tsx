import { useEffect, useRef, useState } from "react";
import { AgentPane } from "./agent/AgentPane";
import { WorkspacesRail, type Workspace } from "./workspace/WorkspacesRail";
import { fetchAppInfo, type AppInfo } from "./ipc";
import { addPane, removePane, type Pane } from "./panes";
import { MAX_PANES, gridTracks, paneGrid } from "./layout";
import "./App.css";

function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    fetchAppInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  const [panes, setPanes] = useState<Pane[]>([{ id: "pane-1", title: "agent-1" }]);
  const nextSeq = useRef(2);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([
    { id: "default", name: "default", agentCount: 1 },
  ]);
  const [activeWorkspace, setActiveWorkspace] = useState("default");

  const addAgent = () => {
    const seq = nextSeq.current;
    nextSeq.current += 1;
    setPanes((current) => addPane(current, seq));
  };
  const closeAgent = (id: string) =>
    setPanes((current) => removePane(current, id));
  const addWorkspace = () =>
    setWorkspaces((list) => {
      const n = list.length + 1;
      return [...list, { id: `ws-${n}`, name: `workspace-${n}`, agentCount: 0 }];
    });

  // Geometry stays valid even with zero panes (an empty 1x1 grid).
  const grid = paneGrid(Math.max(panes.length, 1));
  const atCap = panes.length >= MAX_PANES;
  const railWorkspaces = workspaces.map((w) =>
    w.id === activeWorkspace ? { ...w, agentCount: panes.length } : w,
  );

  return (
    <div className="cockpit">
      <header className="cockpit__bar">
        <span className="cockpit__brand">KeepDeck</span>
        <div className="cockpit__bar-right">
          <button
            type="button"
            className="bar__action"
            onClick={addAgent}
            disabled={atCap}
            title={atCap ? `Max ${MAX_PANES} agents` : "Add agent"}
          >
            + Agent
          </button>
          <span className="cockpit__status">
            {panes.length} {panes.length === 1 ? "pane" : "panes"}
            {info ? ` · core ${info.version}` : ""}
          </span>
        </div>
      </header>
      <div className="cockpit__body">
        <WorkspacesRail
          workspaces={railWorkspaces}
          activeId={activeWorkspace}
          onSelect={setActiveWorkspace}
          onAdd={addWorkspace}
        />
        <main
          className="cockpit__grid"
          style={{
            gridTemplateColumns: gridTracks(grid.columns),
            gridTemplateRows: gridTracks(grid.rows),
          }}
        >
          {panes.map((pane) => (
            <AgentPane
              key={pane.id}
              title={pane.title}
              onClose={() => closeAgent(pane.id)}
            />
          ))}
        </main>
      </div>
    </div>
  );
}

export default App;
