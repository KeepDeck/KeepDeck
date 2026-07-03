import type { AgentInfo } from "../domain/agents";
import type { SpawnPlan } from "../domain/spawnPlans";
import {
  gridTracks,
  paneColumnSpan,
  paneGrid,
  paneGridTrackColumns,
} from "../domain/layout";
import { paneBranchBadge, paneDisplayTitle, resolveFocus } from "../domain/panes";
import type { Workspace } from "../domain/workspaces";
import { AgentPane } from "./agent/AgentPane";
import { WorkspaceSetup } from "./workspace/WorkspaceSetup";

interface DeckStageProps {
  workspaces: Workspace[];
  activeId: string;
  /** Maximized pane per workspace id. */
  focusByWs: Record<string, string>;
  /** The active workspace's highlighted pane (pane ids are app-unique). */
  selectedPaneId: string | null;
  /** Agent catalog, for pane commands and derived titles. */
  agents: AgentInfo[];
  /** The empty-workspace count picker chose `count` agents. */
  onStartWorkspace(wsId: string, count: number): void;
  onSelectPane(wsId: string, paneId: string): void;
  onToggleFocus(wsId: string, paneId: string): void;
  /** Open an agent's working directory in the editor. */
  onOpenInEditor(path: string): void;
  /** Ask to close a pane; `label` is its display title for the confirm. */
  onCloseAgent(wsId: string, paneId: string, label: string): void;
  onRenamePane(wsId: string, paneId: string, name: string): void;
  /** Terminal title changed (OSC) — feeds auto-naming ([F11]). */
  onPaneTitle(wsId: string, paneId: string, title: string): void;
  /** Dormant panes blocked from reviving: paneId → the missing directory
   * ([F7] restore reconcile). */
  dormantBlocked: Record<string, string>;
  /** Spawn plan per live pane — args + env carrying its session identity
   * ([F7]/[F8] v2: assigned id or armed reporter, resume recipe). */
  specByPane: Record<string, SpawnPlan>;
  /** Detach a blocked pane from its gone worktree and start it fresh. */
  onStartFresh(wsId: string, paneId: string): void;
}

/**
 * The stage: every workspace's grid, stacked. Each grid stays MOUNTED and only
 * the active one is visible, so switching workspaces doesn't unmount panes —
 * their PTY sessions keep running in the background. An empty workspace shows
 * the count picker instead of a grid ([F15]).
 */
export function DeckStage({
  workspaces,
  activeId,
  focusByWs,
  selectedPaneId,
  agents,
  onStartWorkspace,
  onSelectPane,
  onToggleFocus,
  onOpenInEditor,
  onCloseAgent,
  onRenamePane,
  onPaneTitle,
  dormantBlocked,
  specByPane,
  onStartFresh,
}: DeckStageProps) {
  return (
    <>
      {workspaces.map((ws) => {
        const isActive = ws.id === activeId;

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
                onPick={(count) => onStartWorkspace(ws.id, count)}
              />
            </div>
          );
        }

        const focusedHere = resolveFocus(ws.panes, focusByWs[ws.id]);
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
              // Agent command/label are per pane (not the workspace), resolved
              // from the fetched catalog ([F1]); fall back to the id string
              // while the catalog is still loading.
              const agentType = pane.agentType ?? "claude";
              const agentInfo = agents.find((a) => a.id === agentType);
              const command = agentInfo?.command ?? agentType;
              const displayTitle = paneDisplayTitle(pane, index, agents);
              const badge = paneBranchBadge(pane);
              return (
                <AgentPane
                  key={pane.id}
                  paneId={pane.id}
                  title={displayTitle}
                  command={command}
                  args={specByPane[pane.id]?.args}
                  env={specByPane[pane.id]?.env}
                  cwd={pane.cwd ?? ws.cwd}
                  branch={badge?.label}
                  branchTitle={badge?.full}
                  visible={isActive && !isCollapsed}
                  focused={isFocused}
                  collapsed={isCollapsed}
                  selected={pane.id === selectedPaneId}
                  solo={solo}
                  dormant={pane.dormant}
                  blockedDir={dormantBlocked[pane.id] ?? null}
                  colSpan={colSpan}
                  onSelect={() => onSelectPane(ws.id, pane.id)}
                  onToggleFocus={() => onToggleFocus(ws.id, pane.id)}
                  onOpenInEditor={() => onOpenInEditor(pane.cwd ?? ws.cwd)}
                  onClose={() => onCloseAgent(ws.id, pane.id, displayTitle)}
                  onRename={(name) => onRenamePane(ws.id, pane.id, name)}
                  onTitle={(t) => onPaneTitle(ws.id, pane.id, t)}
                  onStartFresh={() => onStartFresh(ws.id, pane.id)}
                />
              );
            })}
          </main>
        );
      })}
    </>
  );
}
