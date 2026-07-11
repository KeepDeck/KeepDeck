import type { AgentInfo, SpawnPlan } from "../domain/agents";
import {
  gridTracks,
  paneColumnSpan,
  paneDisplayTitle,
  paneExecutionCwd,
  paneGrid,
  paneGridTrackColumns,
  partitionPanes,
  resolveFocus,
  type GitPosition,
  type Pane,
  type Workspace,
  type WorkspaceView,
} from "../domain/deck";
import type { CollapseStyle } from "../domain/settings";
import { gitBadge } from "../ui/gitBadge";
import { AgentPane } from "./agent/AgentPane";
import { CollapsedItem } from "./deck/CollapsedItem";
import { WorkspaceSetup } from "./workspace/WorkspaceSetup";

interface DeckStageProps {
  workspaces: Workspace[];
  activeId: string;
  /** Per-workspace view state — read for each workspace's maximized pane and
   * its minimized set. */
  viewByWs: Record<string, WorkspaceView>;
  /** The active workspace's highlighted pane (pane ids are app-unique). */
  selectedPaneId: string | null;
  /** How a minimized agent is presented (tray / strip / list) — the [F6]
   * setting; the same value for every workspace. */
  collapseStyle: CollapseStyle;
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
  /** Minimize a pane out of the grid, or restore it (tray/strip styles). */
  onToggleCollapse(wsId: string, paneId: string): void;
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
 * The stage: every workspace's grid, stacked. Each workspace stays MOUNTED and
 * only the active one is visible, so switching workspaces doesn't unmount live
 * panes — their PTY sessions keep running. An empty workspace shows the count
 * picker instead of a grid ([F15]).
 *
 * A minimized agent leaves the grid and is shown as a `CollapsedItem` — the
 * `collapseStyle` decides where: `tray` (chips below the grid), `strip` (folded
 * header bars below the grid), or `list` (the whole workspace becomes a
 * vertical accordion, the selected agent expanded). Minimizing only unmounts
 * the pane's view; the session keeps running and re-mounts on restore.
 */
export function DeckStage({
  workspaces,
  activeId,
  viewByWs,
  selectedPaneId,
  collapseStyle,
  agents,
  agentsReady,
  gitHeads,
  onStartWorkspace,
  onSelectPane,
  onToggleFocus,
  onToggleCollapse,
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

        const view = viewByWs[ws.id];
        // Titles number by the pane's ORIGINAL position, so minimizing one
        // doesn't renumber the rest ("Claude 3" stays "Claude 3").
        const titleOf = (pane: Pane) =>
          paneDisplayTitle(pane, ws.panes.indexOf(pane), agents);
        const badgeOf = (pane: Pane) => {
          const cwd = paneExecutionCwd(ws, pane);
          return gitBadge(cwd ? gitHeads.get(cwd) : undefined);
        };

        // Resolve one pane into a full AgentPane. Shared by the grid and the
        // list's expanded row, so the catalog / spec / cwd / badge resolution
        // lives in ONE place; `layout` carries the per-mode positioning.
        const renderPane = (
          pane: Pane,
          layout: {
            colSpan: number;
            visible: boolean;
            focused: boolean;
            hiddenByMaximize: boolean;
            solo: boolean;
            onCollapse?: () => void;
          },
        ) => {
          // Agent command/label are per pane (not the workspace), resolved from
          // the fetched catalog ([F1]); fall back to the id string while it loads.
          const agentType = pane.agentType ?? "claude";
          const agentInfo = agents.find((a) => a.id === agentType);
          const spec = specByPane[pane.id];
          // The plan's word wins (a hook may pick the user's shell via null);
          // the catalog covers degraded bare plans.
          const command =
            spec?.command !== undefined
              ? spec.command
              : (agentInfo?.command ?? agentType);
          // Judged only against a booted catalog; the card blocks the terminal
          // (and thus the spawn) instead of silently running the bare id.
          const unavailableAgent = agentsReady && !agentInfo ? agentType : null;
          // Plans arrive a beat after the pane (async hooks) — the terminal
          // must not mount (= spawn) before its plan exists.
          const planPending =
            !spec && !pane.dormant && !pane.provisioning && !unavailableAgent;
          const displayTitle = titleOf(pane);
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
              visible={layout.visible}
              focused={layout.focused}
              collapsed={layout.hiddenByMaximize}
              selected={pane.id === selectedPaneId}
              solo={layout.solo}
              dormant={pane.dormant}
              blockedDir={dormantBlocked[pane.id] ?? null}
              provisioning={pane.provisioning}
              unavailableAgent={unavailableAgent}
              colSpan={layout.colSpan}
              onSelect={() => onSelectPane(ws.id, pane.id)}
              onToggleFocus={() => onToggleFocus(ws.id, pane.id)}
              onCollapse={layout.onCollapse}
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
        };

        const wsClass = `deck__workspace${isActive ? "" : " deck__workspace--hidden"}`;

        // ── List style: the whole workspace is a vertical accordion, the
        // selected agent expanded to its terminal, the rest folded to bars. ──
        if (collapseStyle === "list") {
          const expandedId = view?.select ?? ws.panes[0]?.id;
          return (
            <main key={ws.id} className={wsClass} aria-hidden={!isActive}>
              <div className="deck__list">
                {ws.panes.map((pane) =>
                  pane.id === expandedId ? (
                    <div key={pane.id} className="deck__list-open">
                      {renderPane(pane, {
                        colSpan: 1,
                        visible: isActive,
                        focused: false,
                        hiddenByMaximize: false,
                        solo: true,
                      })}
                    </div>
                  ) : (
                    <CollapsedItem
                      key={pane.id}
                      variant="bar"
                      action="expand"
                      title={titleOf(pane)}
                      gitBadge={badgeOf(pane)}
                      label={`Expand ${titleOf(pane)}`}
                      onClick={() => onSelectPane(ws.id, pane.id)}
                    />
                  ),
                )}
              </div>
            </main>
          );
        }

        // ── Tray / strip styles: a grid of the live panes, plus a zone of the
        // minimized ones below it. ───────────────────────────────────────────
        const { live, minimized } = partitionPanes(ws.panes, view?.collapsed);
        const focusedHere = resolveFocus(live, view?.focus);
        const solo = live.length === 1;
        const trackColumns =
          live.length === 0 ? 1 : focusedHere ? 1 : paneGridTrackColumns(live.length);
        const rowCount =
          live.length === 0 ? 1 : focusedHere ? 1 : paneGrid(live.length).rows;

        return (
          <main key={ws.id} className={wsClass} aria-hidden={!isActive}>
            <div className="deck__gridwrap">
              <div
                className="deck__grid"
                style={{
                  gridTemplateColumns: gridTracks(trackColumns),
                  gridTemplateRows: gridTracks(rowCount),
                }}
              >
                {live.length === 0 ? (
                  <div className="deck__grid-empty" role="status">
                    <span className="deck__grid-empty-title">
                      Every agent is minimized
                    </span>
                    <span className="deck__grid-empty-sub">
                      They keep running — restore one below to bring it back
                    </span>
                  </div>
                ) : (
                  live.map((pane, gridIndex) => {
                    const isFocused = pane.id === focusedHere;
                    const hiddenByMaximize = focusedHere !== null && !isFocused;
                    const colSpan = focusedHere
                      ? 1
                      : paneColumnSpan(gridIndex, live.length);
                    return renderPane(pane, {
                      colSpan,
                      visible: isActive && !hiddenByMaximize,
                      focused: isFocused,
                      hiddenByMaximize,
                      solo,
                      onCollapse: () => onToggleCollapse(ws.id, pane.id),
                    });
                  })
                )}
              </div>
            </div>
            {minimized.length > 0 && (
              <div className={collapseStyle === "tray" ? "deck__tray" : "deck__folds"}>
                {collapseStyle === "tray" && (
                  <span className="deck__tray-label">
                    Minimized · {minimized.length}
                  </span>
                )}
                {minimized.map((pane) => (
                  <CollapsedItem
                    key={pane.id}
                    variant={collapseStyle === "tray" ? "chip" : "bar"}
                    action="restore"
                    title={titleOf(pane)}
                    gitBadge={badgeOf(pane)}
                    label={`Restore ${titleOf(pane)}`}
                    onClick={() => onToggleCollapse(ws.id, pane.id)}
                  />
                ))}
              </div>
            )}
          </main>
        );
      })}
    </>
  );
}
