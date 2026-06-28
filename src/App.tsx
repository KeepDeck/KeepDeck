import { useEffect, useState } from "react";
import { TerminalPane } from "./terminal/TerminalPane";
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

  // Skeleton fleet: a single live pane. The grid grows as v1 adds layouts.
  const grid = paneGrid(1);

  return (
    <div className="cockpit">
      <header className="cockpit__bar">
        <span className="cockpit__brand">KeepDeck</span>
        <span className="cockpit__status">
          {info ? `core ${info.version}` : "core …"}
        </span>
      </header>
      <main
        className="cockpit__grid"
        style={{
          gridTemplateColumns: gridTracks(grid.columns),
          gridTemplateRows: gridTracks(grid.rows),
        }}
      >
        <TerminalPane />
      </main>
    </div>
  );
}

export default App;
