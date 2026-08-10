import { useRestart } from "./useRestart";
import type { AgentRestartMode } from "../../domain/agents";
import type { RestartOutcome } from "../../app/agentOrchestrator";
import {
  idleReadsAsStopped,
  type PaneBody,
  type PaneIdle,
  type PaneProvisioning,
} from "../../domain/deck";
import { activityBadge, paneFrame } from "../../domain/status";
import { useWallClock } from "../../ui/useWallClock";
import { usePaneActivity } from "../../app/usePaneActivity";
import { usePaneContextPct } from "../../app/usePaneContextPct";
import { usePaneSessionState } from "../../app/usePaneSessionState";
import { TerminalPane } from "../terminal/TerminalPane";
import { AgentPaneHeader } from "./AgentPaneHeader";
import type { GitBadge } from "../../ui/gitBadge";
import type { AgentGlyphIcon } from "../../ui/AgentGlyph";
import { ProvisioningBody } from "./bodies/ProvisioningBody";
import { StoppedBody } from "./bodies/StoppedBody";
import { UnavailableBody } from "./bodies/UnavailableBody";
import type { UnavailableAgent } from "./unavailableAgent";

export type { UnavailableAgent } from "./unavailableAgent";

export interface AgentPaneProps {
  /** Pane id — used for drag-and-drop hit-testing ([F4], `data-pane-id`). */
  paneId: string;
  title: string;
  /** The agent's brand mark; absent/null draws the neutral fallback. */
  agentIcon?: AgentGlyphIcon | null;
  /** Catalog label for the mark's tooltip — the title can be renamed away
   * from the agent's name, the mark still says who runs here. */
  agentLabel?: string;
  /** Program to run; omitted/null spawns the user's shell. */
  command?: string | null;
  /** Extra CLI args for the program (session identity / resume, [F7]/[F8]). */
  args?: string[];
  /** Extra environment for the program (reporter activation, [F7]/[F8]). */
  env?: [string, string][];
  envDefaults?: [string, string][];
  /** Working directory for the session. */
  cwd?: string | null;
  /** Runtime git badge derived from this pane's effective cwd. */
  gitBadge?: GitBadge | null;
  /** The pane runs in YOLO mode — a standing warning chip in the header, so
   * the disabled-prompts state stays visible for the pane's whole life. */
  yolo?: boolean;
  /** The pane's place on a team, when it is on one — a settled fact handed
   * in, like every other badge here. Teams are formed through the deck's
   * commands (a lead assigns its members), so this is how the person
   * watching learns what the agents arranged among themselves. */
  team?: { name: string; role: string } | null;
  /** Whether the team badge must name the team too — true where the deck
   * runs more than one. Settled by the deck, which is the only level that
   * can see the other teams. */
  showTeamName?: boolean;
  /** Open the team this pane is on — the way in to an existing team, since
   * the bar's button always starts a new one. */
  onOpenTeam?(name: string): void;
  /** Whether this pane is currently on screen. */
  visible: boolean;
  /** Whether this pane is maximized to fill the grid. */
  focused: boolean;
  /** Whether this pane is hidden (display:none, still mounted) — because
   * another pane is maximized, or because it's minimized to the tray/strip. */
  hidden: boolean;
  /** List layout: render header-only (the terminal body is hidden but stays
   * mounted), with a chevron; clicking the header expands it (via onSelect). */
  folded?: boolean;
  /** Whether this is the active pane (gets the highlight border). */
  selected: boolean;
  /** Whether global presentation surfaces allow terminal keyboard focus. */
  keyboardFocusEnabled: boolean;
  /** The only pane in its workspace: no maximize control ([U1]) and no highlight
   * border ([U2]) — there's nothing to maximize over or tell it apart from. */
  solo: boolean;
  /** The pane has no process behind it, and why ([F7]) — render a quiet tile
   * instead of mounting a terminal (mounting is what spawns the PTY). */
  idle?: PaneIdle;
  /** Why the resume the user asked for could not be prepared; the pane stayed
   * stopped and the card says so. */
  wakeError?: string | null;
  /** The missing directory blocking revival, when the pane can't wake where it
   * was ([F7] restore reconcile). */
  blockedDir?: string | null;
  /** Detach from the missing worktree and start fresh in the workspace cwd. */
  onStartFresh?(): void;
  /** Ask for this pane back — the idle card's Resume and, on a pane whose
   * folder is gone, its "Look again". One gesture with two labels rather than
   * two props pointing at one handler: the card already knows which state it
   * is in, and the split invited a caller to wire only one of them. */
  onResume?(): void;
  /** The pane's worktree create in flight or failed — render a status card
   * instead of a terminal until it resolves (optimistic provisioning). */
  provisioning?: PaneProvisioning | null;
  /** The pane's agent can't run — render an explanatory card instead of a
   * terminal; mounting one would spawn the bare id as a command. The union
   * names WHY, because the recovery gestures differ: `no-plugin` means the
   * plugin is disabled or gone; `bin-missing` means it is enabled but the
   * agent's CLI is not installed. */
  unavailableAgent?: UnavailableAgent | null;
  /** The pane's spawn plan is still being built (async plugin hooks) —
   * render the quiet tile instead of a terminal; mounting would spawn
   * without the plan's identity args. */
  body: PaneBody;
  /** Retry building the pane's spawn plan (the error tile's "Try again"). */
  onRetryPlan?(): void;
  /** Re-issue the failed create from its stored intent. */
  onRetryProvision?(): void;
  /** Grid columns this pane spans (>1 lets a partial last row fill the width). */
  colSpan: number;
  onSelect(): void;
  onToggleFocus(): void;
  /** Minimize this agent out of the grid; the button shows only when set (the
   * tray/strip minimize styles). The session keeps running — it's re-mounted
   * on restore. */
  onMinimize?(): void;
  onClose(): void;
  /** Set a manual name ([F11]); an empty name reverts to auto/derived. */
  onRename(name: string): void;
  /** Terminal title changed (OSC) — feeds auto-naming ([F11]). */
  onTitle(title: string): void;
  /** The PTY process ended — the resume-failure detector listens upstream. */
  onExited?(code: number | null): void;
  /** The spawn itself failed — feeds the notification center upstream. */
  onSpawnFailed?(message: string): void;
  /** The agent session this pane would come back to, or null when it would
   * start a new one. The id itself rather than a "can resume" flag: the idle
   * card names the session it will resume, and a flag beside the id would be
   * a second source for the same fact. */
  resumeSessionId?: string | null;
  /** Manually restart an exited agent, either from its binding or fresh. */
  /** Answers what it did. NOT optional-returning: a caller that resolved with
   * nothing would leave the card promising a restart that stood down, which is
   * the bug the outcome exists to prevent. */
  onRestart?(mode: AgentRestartMode): Promise<RestartOutcome>;
}

/**
 * One agent tile in the grid: a thin header (title + maximize + close) over a
 * live terminal pane. Status/telemetry on the header come with the
 * observability milestone.
 */
export function AgentPane({
  paneId,
  title,
  agentIcon,
  agentLabel,
  command,
  args,
  env,
  envDefaults,
  cwd,
  gitBadge,
  yolo,
  team,
  showTeamName,
  onOpenTeam,
  visible,
  focused,
  hidden,
  folded,
  selected,
  keyboardFocusEnabled,
  solo,
  idle,
  wakeError,
  blockedDir,
  provisioning,
  unavailableAgent,
  body,
  onRetryPlan,
  colSpan,
  onSelect,
  onToggleFocus,
  onMinimize,
  onClose,
  onRename,
  onTitle,
  onExited,
  onSpawnFailed,
  resumeSessionId,
  onRestart,
  onStartFresh,
  onResume,
  onRetryProvision,
}: AgentPaneProps) {
  // The live context-occupancy meter for this pane's header — moved off the
  // usage popover, where the per-session rows crowded together and were hard
  // to track. A narrow selector: only this pane re-renders when its own ctx%
  // changes.
  const ctxPct = usePaneContextPct(paneId);
  // What the agent is doing right now (working / waiting / done / failed) —
  // a settled fact from the status tracker; the view only renders it.
  const activity = usePaneActivity(paneId);
  const canResume = !!resumeSessionId;
  // Asked, not re-derived: the deck asks the same question about the same
  // pane for the tray's marker, and the two must not be able to disagree.
  const stopped = idleReadsAsStopped(idle, !!blockedDir);
  // The PTY process has exited (terminal end-state); shows the [U4] placeholder.
  // Read from the session registry rather than remembered here: a pane that
  // exited, was suspended and then resumed kept a local copy alive and painted
  // this card, with a working Restart button, over its fresh terminal.
  const session = usePaneSessionState(paneId);
  // Both terminal states, not just the clean one. A spawn that FAILED leaves
  // no process either, and the sweep will not re-acquire while the registry
  // holds any state for the pane — so with only `exited` handled, a pane whose
  // program could not be launched at all had no card, no Restart and no way
  // back short of closing it.
  const ended =
    session.kind === "exited" || session.kind === "failed" ? session : null;
  // A successful restart remounts the whole pane via its epoch. Until then
  // both choices stay inert, and a pane that stops resets the machine —
  // see [`useRestart`], where those two rules live with their reasoning.
  const { restarting, restartFailed, restart } = useRestart(onRestart, idle);
  // The suspended card and the activity tooltip both date themselves, so the
  // clock has to move even when nothing else re-renders this pane: a quiet
  // deck would otherwise read "now" for as long as it stayed quiet. Either
  // presence arms it; nothing dated leaves it still, which matters because a
  // deck runs one of these per pane.
  const now = useWallClock(0, idle?.reason === "suspended" || activity !== undefined);
  // The context meter belongs on a LIVE pane only — a frozen, undimmed ctx% on
  // an exited / idle / unavailable / provisioning pane would read as live
  // (its last usage report lingers in the store until the pane leaves the deck).
  // The domain's answer, not a second derivation of it: a frozen ctx% on an
  // exited / idle / unavailable / provisioning pane would read as live.
  const paneLive = !ended && body === "terminal";
  // Activity renders VERBATIM from the tracker — no liveness re-derivation
  // here. "Activity describes a live process" has one home: the status
  // channel gates ingest on a live process and clears a pane the moment
  // its process dies, so whatever the store holds is current by contract.
  const activityView = activity ? activityBadge(activity) : null;
  // The ONE frame this pane wears — the domain ranks attention, selection
  // and done; this view only appends the class. The selection-visibility
  // rule (not maximized, not the only pane) predates the ladder and stays.
  const frame = paneFrame(activity, selected && !focused && !solo);
  return (
    <section
      data-pane-id={paneId}
      tabIndex={-1}
      // A stopped pane is dimmed so a grid of six reads at a glance: which
      // ones are actually running is otherwise only visible by looking into
      // each body.
      className={`pane${hidden ? " pane--hidden" : ""}${folded ? " pane--folded" : ""}${frame === "none" ? "" : ` pane--frame-${frame}`}${stopped ? " pane--idle" : ""}`}
      style={colSpan > 1 ? { gridColumn: `span ${colSpan}` } : undefined}
      // A folded row expands only from an EXPLICIT header click (below), never
      // from raw mousedown/focus: descendant focus bubbling would expand rows
      // as Tab passes through their buttons, and a mousedown-select reflows
      // the accordion under the pointer before the click completes.
      onMouseDown={folded ? undefined : onSelect}
      onFocus={folded ? undefined : onSelect}
    >
      {/* Folded: the whole header is the expand control; the action buttons
          stop propagation so they act WITHOUT expanding. */}
      <AgentPaneHeader
        paneId={paneId}
        title={title}
        agentIcon={agentIcon}
        agentLabel={agentLabel}
        folded={folded}
        focused={focused}
        solo={solo}
        activityView={activityView}
        now={now}
        keyboardFocusEnabled={keyboardFocusEnabled}
        ctxPct={ctxPct}
        paneLive={paneLive}
        yolo={yolo}
        team={team}
        showTeamName={showTeamName}
        onOpenTeam={onOpenTeam}
        gitBadge={gitBadge}
        onSelect={onSelect}
        onRename={onRename}
        onMinimize={onMinimize}
        onToggleFocus={onToggleFocus}
        onClose={onClose}
      />
      <div className="pane__body">
        {body === "provisioning" && provisioning ? (
          <ProvisioningBody
            provisioning={provisioning}
            {...(onRetryProvision ? { onRetry: onRetryProvision } : {})}
          />
        ) : body === "agent-unavailable" && unavailableAgent ? (
          <UnavailableBody agent={unavailableAgent} />
        ) : body === "stopped" && idle ? (
          <StoppedBody
            idle={idle}
            stopped={stopped}
            blockedDir={blockedDir}
            wakeError={wakeError}
            resumeSessionId={resumeSessionId}
            now={now}
            {...(onResume ? { onResume } : {})}
            {...(onStartFresh ? { onStartFresh } : {})}
          />
        ) : body === "plan-failed" ? (
          // The spawn plan FAILED to build (e.g. a remote spawn.plan threw).
          // The pane would otherwise hang on "Waking up…" forever — surface
          // the failure and offer a retry (drops it + re-runs the build).
          <div className="pane__card" role="status">
            <span className="pane__exit-title">Couldn't start this agent</span>
            <span className="pane__exit-sub">
              Its spawn plan failed to build — see the log for details.
            </span>
            {onRetryPlan && (
              <button
                type="button"
                className="pane__card-action"
                onClick={onRetryPlan}
              >
                Try again
              </button>
            )}
          </div>
        ) : body === "waiting" ? (
          // The spawn plan is a beat away (async plugin hooks) — same quiet
          // tile as a waking pane; it resolves within milliseconds.
          <div className="pane__card" role="status">
            <span className="pane__exit-title">Waking up…</span>
          </div>
        ) : body === "terminal" ? (
          <TerminalPane
            paneId={paneId}
            command={command}
            args={args}
            env={env}
            envDefaults={envDefaults}
            cwd={cwd}
            visible={visible}
            selected={selected}
            keyboardFocusEnabled={keyboardFocusEnabled}
            onExit={(code, replayed) => {
              // A replay is attachPane re-announcing an old death to a
              // remounted view (plugin toggled off/on over a crashed pane) —
              // the card must return, but upstream once-per-death reactions
              // (crash notification, resume recovery) must not re-fire.
              if (!replayed) onExited?.(code);
            }}
            onSpawnError={(message, replayed) => {
              // Replays restore the inline error for a remounted view; the
              // once-per-failure notification hears only the live event.
              if (!replayed) onSpawnFailed?.(message);
            }}
            onTitle={onTitle}
          />
        ) : body === "provisioning" ||
          body === "agent-unavailable" ||
          body === "stopped" ? (
          // Those three rungs also need the prop that carries their detail,
          // and it is the deck that pairs the two. A body without its detail
          // describes nothing, so render nothing — never the terminal the old
          // fall-through reached for.
          null
        ) : (
          // Every member of the union is answered above, so a NEW one is a
          // type error HERE. That is the whole point of the body being a
          // closed set, and it is what the old hand-written ladder could not
          // give: an unhandled state fell through to a terminal, mounted for a
          // pane that must not have one.
          unreachableBody(body)
        )}
        {ended && !idle && !unavailableAgent && (
          <div className="pane__exit" role="status">
            <span className="pane__exit-title">
              {ended.kind === "failed" ? "Agent didn't start" : "Agent exited"}
            </span>
            <span className="pane__exit-sub pane__exit-detail">
              {ended.kind === "failed"
                ? ended.message
                : ended.code !== null
                  ? `exit code ${ended.code}`
                  : "terminated"}
            </span>
            {onRestart && (
              <div className="pane__exit-actions">
                <button
                  type="button"
                  className="pane__exit-action pane__exit-action--primary"
                  disabled={restarting}
                  onClick={() => restart(canResume ? "resume" : "fresh")}
                >
                  {restarting ? "Restarting…" : "Restart agent"}
                </button>
                {canResume && (
                  <button
                    type="button"
                    className="pane__exit-action pane__exit-action--secondary"
                    disabled={restarting}
                    onClick={() => restart("fresh")}
                  >
                    Start new session
                  </button>
                )}
                {restartFailed && (
                  <span className="pane__exit-restart-error" role="alert">
                    Restart failed
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The body ladder answers every [`PaneBody`] there is, so this is dead at
 * runtime — it exists to make a NEW member a type error here rather than a
 * silent fall-through. It renders nothing if a mismatched prop pair ever
 * reaches it: a blank body is the honest answer to a state nobody described,
 * and strictly better than the terminal the old ladder would have mounted for
 * a pane that must not have one.
 */
function unreachableBody(body: never): null {
  void body;
  return null;
}

