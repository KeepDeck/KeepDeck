import { useEffect, useState } from "react";
import { TerminalPane } from "./terminal/TerminalPane";
import { WorkspacesRail, type Workspace } from "./workspace/WorkspacesRail";
import { fetchAppInfo, type AppInfo } from "./ipc";
import { gridTracks, paneGrid } from "./layout";
import "./App.css";

function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    fetchAppInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  // One live pane for now; feat/dual-pane makes the pane set dynamic.
  const paneIds = ["pane-1"];

  const [workspaces, setWorkspaces] = useState<Workspace[]>([
    { id: "default", name: "default", agentCount: paneIds.length },
  ]);
  const [activeWorkspace, setActiveWorkspace] = useState("default");

  const addWorkspace = () =>
    setWorkspaces((list) => {
      const n = list.length + 1;
      return [...list, { id: `ws-${n}`, name: `workspace-${n}`, agentCount: 0 }];
    });

  const grid = paneGrid(paneIds.length);

  return (
    <div className="cockpit">
      <header className="cockpit__bar">
        <span className="cockpit__brand">KeepDeck</span>
        <span className="cockpit__status">
          {info ? `core ${info.version}` : "core …"}
        </span>
      </header>
      <div className="cockpit__body">
        <WorkspacesRail
          workspaces={workspaces}
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
          {paneIds.map((id) => (
            <TerminalPane key={id} />
          ))}
        </main>
      </div>
    </div>
  );
}

export default App;
