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
import type { CollapseStyle, DeckLayout } from "../domain/settings";
import { gitBadge } from "../ui/gitBadge";
import { AgentPane } from "./agent/AgentPane";
import { CollapsedItem } from "./deck/CollapsedItem";
import { WorkspaceSetup } from "./workspace/WorkspaceSetup";

/** The per-pane positioning the two layouts resolve to; the rest of a pane's
 * props (command, spec, cwd, badge) are the same everywhere. */
interface PaneLayout {
  colSpan: number;
  visible: boolean;
  focused: boolean;
  /** Hidden (display:none) but mounted — maximized-away, or minimized. */
  collapsed: boolean;
  /** Header-only (list layout, a non-expanded row). */
  folded: boolean;
  solo: boolean;
  onCollapse?: () => void;
}

interface DeckStageProps {
  workspaces: Workspace[];
  activeId: string;
  /** Per-workspace view state — read for each workspace's maximized pane, its
   * minimized set, and (in list layout) its expanded pane. */
  viewByWs: Record<string, WorkspaceView>;
  /** The active workspace's highlighted pane (pane ids are app-unique). */
  selectedPaneId: string | null;
  /** How a workspace's agents are laid out (grid / list) — the [F6] setting. */
  deckLayout: DeckLayout;
  /** How a minimized agent is shown in the grid layout (tray / strip). */
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
  /** Minimize a pane out of the grid, or restore it (grid layout only). */
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
 * The stage: every workspace's panes, stacked, only the active one visible.
 *
 * Every pane stays MOUNTED at all times — across workspace switches, layout
 * switches, maximize, and minimize — so a PTY's terminal is never torn down and
 * re-attached (which would flicker and replay its scrollback). What changes is
 * only CSS and props: the grid retiles, a pane is hidden (display:none) or
 * folded to its header, the container flips between grid and list. Nothing
 * unmounts, so switching any of it is seamless.
 *
 * - `grid` layout: the square grid. An agent can be minimized out of it (its
 *   tile is hidden and the grid retiles to fill the space); it's shown as a
 *   `CollapsedItem` in a zone below — `tray` chips or `strip` bars — that
 *   restores it. Maximize still spotlights one live tile.
 * - `list` layout: a vertical accordion — the selected agent expanded to its
 *   terminal, the rest folded to header bars. A display mode, not a minimize:
 *   every agent stays, one is shown at a time. An empty workspace shows the
 *   count picker ([F15]).
 */
export function DeckStage({
  workspaces,
  activeId,
  viewByWs,
  selectedPaneId,
  deckLayout,
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
  const isList = deckLayout === "list";
  // Minimizing is a grid-only affordance, and off entirely under `none`.
  const canMinimize = !isList && collapseStyle !== "none";
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

        // ── Per-pane layout, resolved once per workspace. ─────────────────
        // Grid: the live (not minimized) panes tile; the minimized ones are
        // hidden but stay in the grid mounted. List: the selected pane expands,
        // the rest fold to headers.
        const { live, minimized } = partitionPanes(
          ws.panes,
          canMinimize ? view?.collapsed : undefined,
        );
        const liveIndex = new Map(live.map((p, i) => [p.id, i] as const));
        const focusedHere = isList ? null : resolveFocus(live, view?.focus);
        const soloGrid = live.length === 1;
        const expandedId = view?.select ?? ws.panes[0]?.id;
        const trackColumns =
          live.length === 0 ? 1 : focusedHere ? 1 : paneGridTrackColumns(live.length);
        const rowCount =
          live.length === 0 ? 1 : focusedHere ? 1 : paneGrid(live.length).rows;

        const layoutFor = (pane: Pane): PaneLayout => {
          if (isList) {
            const folded = pane.id !== expandedId;
            return {
              colSpan: 1,
              visible: isActive && !folded,
              focused: false,
              collapsed: false,
              folded,
              solo: true, // no maximize / highlight border in list rows
            };
          }
          if (!liveIndex.has(pane.id)) {
            // Minimized: hidden from the grid (the CollapsedItem below is its
            // stand-in), but mounted so its session doesn't flicker on restore.
            return {
              colSpan: 1,
              visible: false,
              focused: false,
              collapsed: true,
              folded: false,
              solo: false,
            };
          }
          const isFocused = pane.id === focusedHere;
          const hiddenByMaximize = focusedHere !== null && !isFocused;
          return {
            // The pane is live here (the minimized branch returned above), so
            // its live index always resolves.
            colSpan: focusedHere ? 1 : paneColumnSpan(liveIndex.get(pane.id)!, live.length),
            visible: isActive && !hiddenByMaximize,
            focused: isFocused,
            collapsed: hiddenByMaximize,
            folded: false,
            solo: soloGrid,
            // No minimizing the last visible agent — that would leave an empty
            // grid; hide the control until there's more than one live pane.
            onCollapse:
              canMinimize && !soloGrid
                ? () => onToggleCollapse(ws.id, pane.id)
                : undefined,
          };
        };

        // Resolve one pane into a full AgentPane. The catalog / spec / cwd /
        // badge resolution lives in ONE place; `layout` carries positioning.
        const renderPane = (pane: Pane) => {
          const layout = layoutFor(pane);
          const agentType = pane.agentType ?? "claude";
          const agentInfo = agents.find((a) => a.id === agentType);
          const spec = specByPane[pane.id];
          const command =
            spec?.command !== undefined
              ? spec.command
              : (agentInfo?.command ?? agentType);
          const unavailableAgent = agentsReady && !agentInfo ? agentType : null;
          const planPending =
            !spec && !pane.dormant && !pane.provisioning && !unavailableAgent;
          const displayTitle = titleOf(pane);
          const executionCwd = paneExecutionCwd(ws, pane);
          const badge = badgeOf(pane);
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
              collapsed={layout.collapsed}
              folded={layout.folded}
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

        return (
          <main
            key={ws.id}
            className={`deck__workspace${isActive ? "" : " deck__workspace--hidden"}`}
            aria-hidden={!isActive}
          >
            <div className="deck__gridwrap">
              <div
                className={isList ? "deck__list-inner" : "deck__grid"}
                style={
                  isList
                    ? undefined
                    : {
                        gridTemplateColumns: gridTracks(trackColumns),
                        gridTemplateRows: gridTracks(rowCount),
                      }
                }
              >
                {ws.panes.map(renderPane)}
              </div>
              {!isList && live.length === 0 && (
                <div className="deck__grid-empty" role="status">
                  <span className="deck__grid-empty-title">
                    Every agent is minimized
                  </span>
                  <span className="deck__grid-empty-sub">
                    They keep running — restore one below to bring it back
                  </span>
                </div>
              )}
            </div>
            {!isList && minimized.length > 0 && (
              <div className={collapseStyle === "tray" ? "deck__tray" : "deck__folds"}>
                {collapseStyle === "tray" && (
                  <span className="deck__tray-label">
                    Minimized · {minimized.length}
                  </span>
                )}
                {minimized.map((pane) => {
                  const title = titleOf(pane);
                  return (
                    <CollapsedItem
                      key={pane.id}
                      variant={collapseStyle === "tray" ? "chip" : "bar"}
                      title={title}
                      gitBadge={badgeOf(pane)}
                      label={`Restore ${title}`}
                      onClick={() => onToggleCollapse(ws.id, pane.id)}
                    />
                  );
                })}
              </div>
            )}
          </main>
        );
      })}
    </>
  );
}
