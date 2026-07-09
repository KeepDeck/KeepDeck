import type { AgentInfo, SpawnPlan } from "../domain/agents";
import {
  gridTracks,
  paneColumnSpan,
  paneDisplayTitle,
  paneExecutionCwd,
  paneGrid,
  paneGridTrackColumns,
  resolveFocus,
  type GitPosition,
  type Workspace,
  type WorkspaceView,
} from "../domain/deck";
import { gitBadge } from "../ui/gitBadge";
import { AgentPane } from "./agent/AgentPane";
import { WorkspaceSetup } from "./workspace/WorkspaceSetup";

interface DeckStageProps {
  workspaces: Workspace[];
  activeId: string;
  /** Per-workspace view state — read for each workspace's maximized pane. */
  viewByWs: Record<string, WorkspaceView>;
  /** The active workspace's highlighted pane (pane ids are app-unique). */
  selectedPaneId: string | null;
  /** Agent catalog, for pane commands and derived titles. */
  agents: AgentInfo[];
  /** The catalog reflects the booted plugin system — only then can a pane's
   * agent be judged missing (before boot, EVERY id is absent from it). */
  agentsReady: boolean;
  /** Runtime git HEAD observations, keyed by pane execution cwd. */
  gitHeads: ReadonlyMap<string, GitPosition>;
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
  /** Re-issue a failed pane's worktree create (the failed card's Retry). */
  onRetryProvision(wsId: string, paneId: string): void;
  /** A pane's PTY exited (the resume-failure detector lives upstream). */
  onAgentExited(wsId: string, paneId: string, code: number | null): void;
  /** Bumped to force a pane's full remount — the respawn-fresh path after a
   * dead resume (an exited session is never silently respawned in place). */
  respawnEpochs: ReadonlyMap<string, number>;
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
  viewByWs,
  selectedPaneId,
  agents,
  agentsReady,
  gitHeads,
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
  onRetryProvision,
  onAgentExited,
  respawnEpochs,
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

        const focusedHere = resolveFocus(ws.panes, viewByWs[ws.id]?.focus);
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
              const spec = specByPane[pane.id];
              // The plan's word wins (a hook may pick the user's shell via
              // null); the catalog covers degraded bare plans.
              const command =
                spec?.command !== undefined
                  ? spec.command
                  : (agentInfo?.command ?? agentType);
              // Judged only against a booted catalog; the card blocks the
              // terminal (and thus the spawn) instead of silently running
              // the bare id as a command.
              const unavailableAgent =
                agentsReady && !agentInfo ? agentType : null;
              // Plans arrive a beat after the pane (async hooks) — the
              // terminal must not mount (= spawn) before its plan exists.
              const planPending =
                !spec &&
                !pane.dormant &&
                !pane.provisioning &&
                !unavailableAgent;
              const displayTitle = paneDisplayTitle(pane, index, agents);
              const executionCwd = paneExecutionCwd(ws, pane);
              const badge = gitBadge(
                executionCwd ? gitHeads.get(executionCwd) : undefined,
              );
              return (
                <AgentPane
                  key={`${pane.id}#${respawnEpochs.get(pane.id) ?? 0}`}
                  paneId={pane.id}
                  title={displayTitle}
                  command={command}
                  args={spec?.args}
                  env={spec?.env}
                  planPending={planPending}
                  cwd={executionCwd}
                  gitBadge={badge}
                  visible={isActive && !isCollapsed}
                  focused={isFocused}
                  collapsed={isCollapsed}
                  selected={pane.id === selectedPaneId}
                  solo={solo}
                  dormant={pane.dormant}
                  blockedDir={dormantBlocked[pane.id] ?? null}
                  provisioning={pane.provisioning}
                  unavailableAgent={unavailableAgent}
                  colSpan={colSpan}
                  onSelect={() => onSelectPane(ws.id, pane.id)}
                  onToggleFocus={() => onToggleFocus(ws.id, pane.id)}
                  onOpenInEditor={() => {
                    if (executionCwd) onOpenInEditor(executionCwd);
                  }}
                  onClose={() => onCloseAgent(ws.id, pane.id, displayTitle)}
                  onRename={(name) => onRenamePane(ws.id, pane.id, name)}
                  onTitle={(t) => onPaneTitle(ws.id, pane.id, t)}
                  onStartFresh={() => onStartFresh(ws.id, pane.id)}
                  onRetryProvision={() => onRetryProvision(ws.id, pane.id)}
                  onExited={(code) => onAgentExited(ws.id, pane.id, code)}
                />
              );
            })}
          </main>
        );
      })}
    </>
  );
}
