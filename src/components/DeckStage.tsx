import type { AgentInfo, AgentRestartMode } from "../domain/agents";
import type { SpawnPlan } from "../app/spawnSpecs";
import {
  gridTracks,
  paneColumnSpan,
  paneDisplayTitle,
  paneAgentType,
  paneExecutionCwd,
  paneGrid,
  paneGridTrackColumns,
  idleReadsAsStopped,
  paneResumeSessionId,
  resolveFocus,
  visiblePanes,
  type GitPosition,
  type Pane,
  type Workspace,
  type WorkspaceView,
  paneBody,
  paneProvisioning,
  stagePanes,
  teamOfPane,
} from "../domain/deck";
import type { PaneFramePlace } from "../domain/status";
import { teamNamesIn, teamOf } from "../domain/mail";
import { gitBadge } from "../ui/gitBadge";
import { AgentPane, type UnavailableAgent } from "./agent/AgentPane";
import { MinimizedTray, type MinimizedTrayEntry } from "./deck/MinimizedTray";
import { TeamCards } from "./deck/TeamCards";
import { trayView, type ShelfEntry } from "../presentation/trayView";
import type { JournalRecords, SessionHandle } from "../domain/journal";
import type { BrowserSharedSeam } from "../app/useSessionsBrowser";
import { stageContent } from "../presentation/stageView";
import { startFreshRoles } from "../presentation/startFreshView";
import { TeamSessions } from "./deck/TeamSessions";
import type { RestartOutcome } from "../app/agentOrchestrator";

/** The per-pane positioning the grid resolves to; the rest of a pane's props
 * (command, spec, cwd, badge) are the same everywhere. */
interface PaneLayout {
  colSpan: number;
  visible: boolean;
  focused: boolean;
  /** Hidden (display:none) but mounted — maximized-away, or minimized. */
  hidden: boolean;
  solo: boolean;
  /** The pane's place as the frame ladder sees it — stated HERE, the one
   * surface that knows what is rendering (`solo` is chrome vocabulary; the
   * ladder asks whether the pane fills the stage). */
  framePlace: PaneFramePlace;
  onMinimize?: () => void;
}

interface DeckStageProps {
  workspaces: Workspace[];
  activeId: string;
  /** Per-workspace view state — read for each workspace's maximized pane and
   * its minimized set. */
  viewByWs: Record<string, WorkspaceView>;
  /** The active workspace's highlighted pane (pane ids are app-unique). */
  selectedPaneId: string | null;
  /** Whether a terminal may receive keyboard focus above global UI surfaces. */
  keyboardFocusEnabled: boolean;
  /** Agent catalog, for pane commands and derived titles. */
  agents: AgentInfo[];
  /** The catalog reflects the booted plugin system — only then can a pane's
   * agent be judged missing (before boot, EVERY id is absent from it). */
  agentsReady: boolean;
  /** agentId → gate reason for agents whose plugin is enabled but
   * `unavailable` (CLI not installed) — lets the pane card tell "install the
   * CLI" apart from "no plugin provides this agent". */
  unavailableAgentReasons: ReadonlyMap<string, string>;
  /** Runtime git HEAD observations, keyed by pane execution cwd. */
  gitHeads: ReadonlyMap<string, GitPosition>;
  /** The session journal's folded records — an empty team's sessions. */
  journal: JournalRecords;
  /** Continue a recorded session onto an empty team, under the role picked
   * there — resumed, or forked into the team's directory. */
  onContinueSession(
    wsId: string,
    teamId: string,
    mode: "resume" | "fork",
    record: SessionHandle,
    role: string,
  ): void;
  /** The browser seam's shared half (keyed enrichment + freshness +
   * transcript dispatch) — one instance app-wide; each browser builds its
   * own folder-scoped engines on top of it. */
  browserShared: BrowserSharedSeam;
  onSelectPane(wsId: string, paneId: string): void;
  onToggleFocus(wsId: string, paneId: string): void;
  /** Minimize a pane out of the grid, or restore it (grid layout only). */
  onToggleMinimize(wsId: string, paneId: string): void;
  /** Return a suspended pane from its tray placement without resuming it. */
  onRestoreSuspendedPane(wsId: string, paneId: string): void;
  /** Ask to close a pane; `label` is its display title for the confirm. */
  onCloseAgent(wsId: string, paneId: string, label: string): void;
  onRenamePane(wsId: string, paneId: string, name: string): void;
  /** Drill into a team from its card — the stage's level moves. */
  onEnterTeam(wsId: string, teamId: string): void;
  /** Put another agent on a team, from its card's menu. */
  onAddTeamMember(wsId: string, teamId: string): void;
  onRenameTeam(wsId: string, teamId: string, name: string): void;
  /** Ask to disband a team — the close flow's own question. */
  onDisbandTeam(wsId: string, teamId: string): void;
  /** Terminal title changed (OSC) — feeds auto-naming ([F11]). */
  onPaneTitle(wsId: string, paneId: string, title: string): void;
  /** Idle panes blocked from waking: paneId → the missing directory
   * ([F7] restore reconcile). */
  idleBlocked: Record<string, string>;
  /** Panes whose user-requested resume could not be prepared: paneId → why.
   * They stayed stopped; their cards explain instead of coming up as a
   * different conversation. */
  wakeFailed: Record<string, string>;
  /** Panes whose refused resume holds a LIVE outside session: paneId → the
   * note their cards offer a choice on (fork a copy, leave it). The binding
   * is intact; nothing was erased. */
  occupiedPanes: Record<
    string,
    { registry: "live" | "unknown"; name: string | null }
  >;
  /** Fork the occupied card's live session into a copy (same directory). */
  onForkOccupied(wsId: string, paneId: string): void;
  /** Panes waiting on a continuation to paint: paneId → when the wait began
   * and whether it has already outlasted a healthy start. */
  startupPanes: Record<string, { since: number; slow: boolean }>;
  /** Fork the session of a pane whose start has gone quiet (same directory,
   * nothing killed). */
  onForkStalled(wsId: string, paneId: string): void;
  /** Stop offering the occupied choice (pane stays visible and bound). */
  onDismissOccupied(paneId: string): void;
  /** Spawn plan per live pane — args + env carrying its session identity
   * ([F7]/[F8] v2: assigned id or armed reporter, resume recipe). */
  specByPane: Record<string, SpawnPlan>;
  /** Panes whose spawn plan last failed to build — the deck shows them an
   *  error tile (with retry) instead of "Waking up…". Surfaced through the
   *  spawn-specs snapshot so a failure re-renders the deck with the set in
   *  hand (no module-state side-channel). */
  failedPanes: ReadonlySet<string>;
  /** Detach a blocked pane from its gone worktree and start it fresh —
   * under `role` when its own could not come along. */
  onStartFresh(wsId: string, paneId: string, role?: string): void;
  /** Wake a suspended (or parked) pane — the idle card's own gesture. */
  onResumeAgent(wsId: string, paneId: string): void;
  /** Re-issue a failed pane's worktree create (the failed card's Retry). */
  /** Re-issue the failed create behind a card — the TEAM's card. */
  onRetryProvision(wsId: string, teamId: string): void;
  /** A pane's PTY exited (the resume-failure detector lives upstream). */
  onAgentExited(wsId: string, paneId: string, code: number | null): void;
  /** A pane's spawn failed — feeds the notification center. */
  onAgentSpawnFailed(wsId: string, paneId: string, message: string): void;
  /** Explicitly restart an exited pane, resuming its exact binding or fresh. */
  onRestartAgent(
    wsId: string,
    paneId: string,
    mode: AgentRestartMode,
  ): Promise<RestartOutcome>;
  /** Bumped after the old PTY entry is retired to remount the same pane. */
  restartEpochs: Record<string, number>;
  /** Retry a pane whose spawn plan failed to build (no PTY was spawned) —
   *  drops the failure and re-runs the build. */
  onRetryPlanBuild(paneId: string): void;
}

/**
 * The stage: every workspace's panes, stacked, only the active one visible.
 *
 * Every pane stays MOUNTED at all times — across workspace switches,
 * maximize, and minimize — so a PTY's terminal is never torn down and
 * re-attached (which would flicker and replay its scrollback). What changes is
 * only CSS and props: the grid retiles, a pane is hidden (display:none).
 * Nothing unmounts, so switching any of it is seamless.
 *
 * The square grid: an agent can be minimized out of it (its tile is hidden
 * and the grid retiles to fill the space); it's shown as a chip in the tray
 * below, which restores it. Maximize still spotlights one live tile, and the
 * tiles it hides are listed in that same tray as if minimized — restoring
 * one of them switches the spotlight to it instead of exiting maximize.
 * Under the optional Tray placement, explicitly suspended agents use the
 * same bottom shelf. What goes over the grid — the team cards, an empty
 * team's sessions, a word — is the stage model's answer ([`stageContent`]).
 */
export function DeckStage({
  workspaces,
  activeId,
  viewByWs,
  selectedPaneId,
  keyboardFocusEnabled,
  agents,
  agentsReady,
  unavailableAgentReasons,
  gitHeads,
  journal,
  onContinueSession,
  browserShared,
  onSelectPane,
  onToggleFocus,
  onToggleMinimize,
  onRestoreSuspendedPane,
  onCloseAgent,
  onRenamePane,
  onEnterTeam,
  onAddTeamMember,
  onRenameTeam,
  onDisbandTeam,
  onPaneTitle,
  idleBlocked,
  wakeFailed,
  occupiedPanes,
  onForkOccupied,
  startupPanes,
  onForkStalled,
  onDismissOccupied,
  specByPane,
  failedPanes,
  onStartFresh,
  onResumeAgent,
  onRetryProvision,
  onAgentExited,
  onAgentSpawnFailed,
  onRestartAgent,
  restartEpochs,
  onRetryPlanBuild,
}: DeckStageProps) {
  return (
    <>
      {workspaces.map((ws) => {
        const isActive = ws.id === activeId;

        const view = viewByWs[ws.id];
        // ── The slice. ────────────────────────────────────────────────────
        // The open team's members are what the stage lays out. Every other
        // team's panes stay MOUNTED — a terminal is never torn down for a
        // change of level — and merely are not on the grid, the shelf, or
        // the empty-grid word: each of those reads the slice, never the
        // workspace. The live (not minimized) panes tile; the minimized
        // ones — and the panes of teams that are not open — are hidden but
        // stay mounted.
        const panes = stagePanes(ws, view);
        const live = visiblePanes(panes, view);
        // What goes over the grid, asked once.
        const content = stageContent(ws, view, live.length);

        // A workspace with no team: nothing to lay out, and the word for it.
        if (content.kind === "no-teams") {
          const { word } = content;
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
              <div className="deck__grid-empty" role="status">
                <span className="deck__grid-empty-title">{word.title}</span>
                <span className="deck__grid-empty-sub">{word.sub}</span>
              </div>
            </div>
          );
        }

        // Titles number by the pane's ORIGINAL position, so minimizing one
        // doesn't renumber the rest ("Claude 3" stays "Claude 3").
        const titleOf = (pane: Pane) =>
          paneDisplayTitle(pane, ws.panes.indexOf(pane), agents);
        const badgeOf = (pane: Pane) => {
          const cwd = paneExecutionCwd(ws, pane);
          return gitBadge(cwd ? gitHeads.get(cwd) : undefined);
        };

        // ── Per-pane layout, resolved once per workspace. ─────────────────
        const liveIndex = new Map(live.map((p, i) => [p.id, i] as const));
        const focusedHere = resolveFocus(live, view?.focus);
        const soloGrid = live.length === 1;
        const trackColumns =
          live.length === 0 ? 1 : focusedHere ? 1 : paneGridTrackColumns(live.length);
        const rowCount =
          live.length === 0 ? 1 : focusedHere ? 1 : paneGrid(live.length).rows;

        const layoutFor = (pane: Pane): PaneLayout => {
          if (!liveIndex.has(pane.id)) {
            // Hidden from the grid, but still mounted. In addition to
            // explicit minimizes this includes suspended panes while the
            // global placement is Tray and its suspend transition put it in
            // the existing minimized set — and every pane of a team that is
            // not the open one. A hidden pane is never the selected one —
            // selection resolves to a live, visible pane (the same contract
            // MinimizedItem documents for its chip).
            return {
              colSpan: 1,
              visible: false,
              focused: false,
              hidden: true,
              solo: false,
              framePlace: { selected: false, fullBleed: false },
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
            hidden: hiddenByMaximize,
            solo: soloGrid,
            // Only a grid pane can fill the stage: maximized by hand, or the
            // one live pane left. Selection stays truthful — the ladder's
            // full-bleed gate decides whether it ever wears.
            framePlace: {
              selected: pane.id === selectedPaneId,
              fullBleed: isFocused || soloGrid,
            },
            // No minimizing the last visible agent — that would leave an empty
            // grid; hide the control until there's more than one live pane.
            onMinimize: soloGrid
              ? undefined
              : () => onToggleMinimize(ws.id, pane.id),
          };
        };

        // ── Tray entries. ─────────────────────────────────────────────────
        // Who is on the shelf and why is the projection's answer; what each
        // reason DOES is this component's, because it owns the callbacks. The
        // switch is exhaustive: a reason the shelf learns to report cannot be
        // one the stage forgets to honour.
        const shelf = trayView(panes, view, focusedHere);
        const restoreFor = (entry: ShelfEntry): (() => void) => {
          switch (entry.reason) {
            case "minimized":
              return () => onToggleMinimize(ws.id, entry.paneId);
            case "suspendedTray":
              return () => onRestoreSuspendedPane(ws.id, entry.paneId);
            case "maximized":
              // Not the minimized-restore (that exits maximize): switch the
              // spotlight to this pane, keeping the fullscreen mode.
              return () => {
                onSelectPane(ws.id, entry.paneId);
                onToggleFocus(ws.id, entry.paneId);
              };
            default: {
              const unhandled: never = entry.reason;
              throw new Error(`unhandled shelf reason: ${String(unhandled)}`);
            }
          }
        };
        // "Reads as stopped", decided once per pane and shared by the tile and
        // the tray stand-in. A pane on its way up is excluded (it resolves in
        // milliseconds and would only flicker) — but one BLOCKED on a missing
        // folder is stuck until the user relocates it, and when it is also
        // minimized the chip is the only thing left to say the agent is dead.
        const stoppedById = new Map(
          ws.panes.map((pane) => [
            pane.id,
            idleReadsAsStopped(pane.idle, !!idleBlocked[pane.id]),
          ]),
        );
        // Pane order, so an explicit minimize and a maximize-hidden pane sit
        // where their tiles were.
        const entryOf = (
          pane: Pane,
          label: string,
          onRestore: () => void,
        ): MinimizedTrayEntry => {
          const title = titleOf(pane);
          const team = teamOf(ws, pane);
          return {
            id: pane.id,
            title,
            icon:
              agents.find((a) => a.id === paneAgentType(pane))?.icon ?? null,
            gitBadge: badgeOf(pane),
            team,
            yolo: pane.yolo,
            stopped: stoppedById.get(pane.id) ?? false,
            label: team
              ? `${label} ${title}, ${team.role} on team ${team.name}`
              : `${label} ${title}`,
            onRestore,
          };
        };
        const paneById = new Map(ws.panes.map((pane) => [pane.id, pane]));
        const trayEntries = shelf.entries.map((entry) =>
          entryOf(paneById.get(entry.paneId)!, "Restore", restoreFor(entry)),
        );
        const trayStateLabel = shelf.stateLabel;

        // Asked once for the deck, not once per pane: a role is only an
        // identity while ONE team holds it, and with a second team running
        // every badge needs to say which one it belongs to. The pane itself
        // cannot see that — from where it stands, `lead` looks unique.
        const teamsHere = teamNamesIn(ws).length;

        // Resolve one pane into a full AgentPane. The catalog / spec / cwd /
        // badge resolution lives in ONE place; `layout` carries positioning.
        const renderPane = (pane: Pane) => {
          const layout = layoutFor(pane);
          const agentType = paneAgentType(pane);
          const agentInfo = agents.find((a) => a.id === agentType);
          const spec = specByPane[pane.id];
          const command =
            spec?.command !== undefined
              ? spec.command
              : (agentInfo?.command ?? agentType);
          const unavailableAgent: UnavailableAgent | null =
            agentsReady && !agentInfo
              ? (() => {
                  const reason = unavailableAgentReasons.get(agentType);
                  return reason !== undefined
                    ? { kind: "bin-missing", agent: agentType, reason }
                    : { kind: "no-plugin", agent: agentType };
                })()
              : null;
          // One question, one answer — the conjunction used to be spelled
          // out here and again inside the pane.
          const body = paneBody(ws, pane, {
            agentAvailable: !unavailableAgent,
            hasPlan: !!spec,
            planFailed: failedPanes.has(pane.id),
          });
          const displayTitle = titleOf(pane);
          const executionCwd = paneExecutionCwd(ws, pane);
          const badge = badgeOf(pane);
          return (
            <AgentPane
              key={`${pane.id}#${restartEpochs[pane.id] ?? 0}`}
              paneId={pane.id}
              title={displayTitle}
              agentIcon={agentInfo?.icon ?? null}
              agentLabel={agentInfo?.label ?? agentType}
              command={command}
              args={spec?.args}
              env={spec?.env}
              envDefaults={spec?.envDefaults}
              body={body}
              onRetryPlan={() => onRetryPlanBuild(pane.id)}
              cwd={executionCwd}
              gitBadge={badge}
              yolo={pane.yolo}
              team={teamOf(ws, pane)}
              showTeamName={teamsHere > 1}
              visible={layout.visible}
              focused={layout.focused}
              hidden={layout.hidden}
              selected={pane.id === selectedPaneId}
              keyboardFocusEnabled={keyboardFocusEnabled}
              solo={layout.solo}
              framePlace={layout.framePlace}
              idle={pane.idle}
              wakeError={wakeFailed[pane.id] ?? null}
              blockedDir={idleBlocked[pane.id] ?? null}
              occupied={occupiedPanes[pane.id] ?? null}
              onForkOccupied={() => onForkOccupied(ws.id, pane.id)}
              onDismissOccupied={() => onDismissOccupied(pane.id)}
              startup={startupPanes[pane.id] ?? null}
              onForkStalled={() => onForkStalled(ws.id, pane.id)}
              provisioning={paneProvisioning(ws, pane)}
              unavailableAgent={unavailableAgent}
              colSpan={layout.colSpan}
              onSelect={() => onSelectPane(ws.id, pane.id)}
              onToggleFocus={() => onToggleFocus(ws.id, pane.id)}
              onMinimize={layout.onMinimize}
              onClose={() => onCloseAgent(ws.id, pane.id, displayTitle)}
              onRename={(name) => onRenamePane(ws.id, pane.id, name)}
              onTitle={(t) => onPaneTitle(ws.id, pane.id, t)}
              startFreshRoles={
                idleBlocked[pane.id] ? startFreshRoles(workspaces, ws, pane) : null
              }
              onStartFresh={(role) => onStartFresh(ws.id, pane.id, role)}
              onResume={() => onResumeAgent(ws.id, pane.id)}
              onRetryProvision={() => {
                // The card, and its Retry, are the team's.
                const team = teamOfPane(ws, pane);
                if (team) onRetryProvision(ws.id, team.id);
              }}
              onExited={(code) => onAgentExited(ws.id, pane.id, code)}
              onSpawnFailed={(message) =>
                onAgentSpawnFailed(ws.id, pane.id, message)
              }
              resumeSessionId={paneResumeSessionId(pane)}
              onRestart={(mode) => onRestartAgent(ws.id, pane.id, mode)}
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
                className="deck__grid"
                style={{
                  gridTemplateColumns: gridTracks(trackColumns),
                  gridTemplateRows: gridTracks(rowCount),
                }}
              >
                {ws.panes.map(renderPane)}
              </div>
              {content.kind === "word" && (
                <div className="deck__grid-empty" role="status">
                  <span className="deck__grid-empty-title">{content.word.title}</span>
                  <span className="deck__grid-empty-sub">{content.word.sub}</span>
                </div>
              )}
              {content.kind === "team-sessions" && (
                <TeamSessions
                  ws={ws}
                  cwd={content.cwd}
                  journal={journal}
                  browserShared={browserShared}
                  agents={agents}
                  agentsReady={agentsReady}
                  onContinue={(mode, record, role) =>
                    onContinueSession(ws.id, content.teamId, mode, record, role)
                  }
                />
              )}
              {/* The cards level, laid over the mounted grid while no team
                  is open — the same place the empty-grid word takes, for
                  the same reason: the panes underneath never unmount. Its
                  own component, so ONE status subscription serves every
                  card, and so the pane nodes above keep their container
                  (and their identity) through every change of level. */}
              {content.kind === "cards" && (
                <TeamCards
                  workspace={ws}
                  gitHeads={gitHeads}
                  keyboardFocusEnabled={keyboardFocusEnabled && isActive}
                  onEnter={(teamId) => onEnterTeam(ws.id, teamId)}
                  onAddMember={(teamId) => onAddTeamMember(ws.id, teamId)}
                  onRename={(teamId, name) => onRenameTeam(ws.id, teamId, name)}
                  onDisband={(teamId) => onDisbandTeam(ws.id, teamId)}
                  onRetry={(teamId) => onRetryProvision(ws.id, teamId)}
                />
              )}
            </div>
            {trayEntries.length > 0 && (
              <MinimizedTray
                active={isActive}
                entries={trayEntries}
                stateLabel={trayStateLabel}
              />
            )}
          </main>
        );
      })}
    </>
  );
}
