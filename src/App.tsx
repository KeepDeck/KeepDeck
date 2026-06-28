import { useEffect, useRef, useState } from "react";
import { AgentPane } from "./agent/AgentPane";
import { WorkspacesRail } from "./workspace/WorkspacesRail";
import { WorkspaceSetup } from "./workspace/WorkspaceSetup";
import { fetchAppInfo, type AppInfo } from "./ipc";
import {
  addAgent,
  addWorkspace,
  closeAgent,
  closeWorkspace,
  renameWorkspace,
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
  // Maximized pane per workspace (workspace id -> pane id), so focus persists
  // across workspace switches.
  const [focusByWs, setFocusByWs] = useState<Record<string, string>>({});
  const nextAgentSeq = useRef(1);
  const nextWorkspaceSeq = useRef(1);

  const active = workspaces.find((w) => w.id === activeId) ?? null;

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
  };

  const toggleFocus = (workspaceId: string, paneId: string) =>
    setFocusByWs((cur) => {
      const next = { ...cur };
      if (next[workspaceId] === paneId) delete next[workspaceId];
      else next[workspaceId] = paneId;
      return next;
    });

  const handleAddWorkspace = () => {
    const seq = nextWorkspaceSeq.current;
    nextWorkspaceSeq.current += 1;
    const id = `ws-${seq}`;
    setWorkspaces((current) => addWorkspace(current, seq));
    setActiveId(id);
  };

  const handleRenameWorkspace = (id: string, name: string) =>
    setWorkspaces((current) => renameWorkspace(current, id, name));

  // Start an empty workspace with `count` terminals at once (seqs minted here,
  // not in the updater, so React StrictMode's double-invoke can't skew them).
  const handleStartWorkspace = (workspaceId: string, count: number) => {
    const seqs: number[] = [];
    for (let i = 0; i < count; i++) seqs.push(nextAgentSeq.current++);
    setWorkspaces((current) =>
      seqs.reduce((acc, seq) => addAgent(acc, workspaceId, seq), current),
    );
  };

  const handleCloseWorkspace = (id: string) => {
    // Removing the workspace unmounts its panes, which tears down their PTY
    // sessions (no leaks).
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
          onRename={handleRenameWorkspace}
        />
        {/* Every workspace's grid stays mounted (sessions keep running); only
            the active one is visible. */}
        <div className="cockpit__stage">
          {workspaces.map((ws) => {
            const isActive = ws.id === activeId;

            // Empty workspace → show the terminal-count setup instead of a grid.
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
            const grid = focusedHere
              ? { columns: 1, rows: 1 }
              : paneGrid(ws.panes.length);
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
                {ws.panes.map((pane) => {
                  const isFocused = pane.id === focusedHere;
                  const isCollapsed = focusedHere !== null && !isFocused;
                  return (
                    <AgentPane
                      key={pane.id}
                      title={pane.title}
                      visible={isActive && !isCollapsed}
                      focused={isFocused}
                      collapsed={isCollapsed}
                      onToggleFocus={() => toggleFocus(ws.id, pane.id)}
                      onClose={() => handleCloseAgent(ws.id, pane.id)}
                    />
                  );
                })}
              </main>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default App;
