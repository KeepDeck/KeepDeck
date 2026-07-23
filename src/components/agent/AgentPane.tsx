import { useRef, useState } from "react";
import type { AgentRestartMode } from "../../domain/agents";
import type { PaneProvisioning } from "../../domain/deck";
import { contextLevel } from "../../domain/usage";
import { usePaneContextPct } from "../../app/usePaneContextPct";
import { TerminalPane } from "../terminal/TerminalPane";
import { noAutoCorrect } from "../../ui/inputProps";
import {
  BoltIcon,
  ChevronDownIcon,
  GitBranchIcon,
  MaximizeIcon,
  MinimizeIcon,
  RestoreIcon,
} from "../../ui/icons";
import { CloseButton } from "../../ui/CloseButton";
import { Chip } from "../../ui/Chip";
import type { GitBadge } from "../../ui/gitBadge";
import { AgentGlyph, type AgentGlyphIcon } from "../../ui/AgentGlyph";
import { LaunchSpinner } from "../../ui/LaunchSpinner";

interface AgentPaneProps {
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
  /** The only pane in its workspace: no maximize control ([U1]) and no highlight
   * border ([U2]) — there's nothing to maximize over or tell it apart from. */
  solo: boolean;
  /** Restored from disk, not yet revived ([F7]) — render a quiet tile instead
   * of mounting a terminal (mounting is what spawns the PTY). */
  dormant?: boolean;
  /** The missing directory blocking revival, when the pane can't wake where it
   * was ([F7] restore reconcile). */
  blockedDir?: string | null;
  /** Detach from the missing worktree and start fresh in the workspace cwd. */
  onStartFresh?(): void;
  /** The pane's worktree create in flight or failed — render a status card
   * instead of a terminal until it resolves (optimistic provisioning). */
  provisioning?: PaneProvisioning | null;
  /** The pane's agent id when NO plugin provides it (disabled/uninstalled) —
   * render an explanatory card instead of a terminal; mounting one would
   * spawn the bare id as a command. */
  unavailableAgent?: string | null;
  /** The pane's spawn plan is still being built (async plugin hooks) —
   * render the quiet tile instead of a terminal; mounting would spawn
   * without the plan's identity args. */
  planPending?: boolean;
  /** The pane's spawn plan FAILED to build (e.g. a remote spawn.plan threw) —
   *  render an error tile with a retry instead of "Waking up…" forever. */
  planError?: boolean;
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
  /** Whether the exited process is bound to a resumable agent session. */
  canResume?: boolean;
  /** Manually restart an exited agent, either from its binding or fresh. */
  onRestart?(mode: AgentRestartMode): Promise<void> | void;
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
  visible,
  focused,
  hidden,
  folded,
  selected,
  solo,
  dormant,
  blockedDir,
  provisioning,
  unavailableAgent,
  planPending,
  planError,
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
  canResume,
  onRestart,
  onStartFresh,
  onRetryProvision,
}: AgentPaneProps) {
  // The live context-occupancy meter for this pane's header — moved off the
  // usage popover, where the per-session rows crowded together and were hard
  // to track. A narrow selector: only this pane re-renders when its own ctx%
  // changes.
  const ctxPct = usePaneContextPct(paneId);
  // The PTY process has exited (terminal end-state); shows the [U4] placeholder.
  const [exit, setExit] = useState<{ code: number | null } | null>(null);
  // A successful restart remounts the whole pane via its epoch. Until then,
  // keep both choices inert; only a rejected plan lets the user try again.
  const restartInFlight = useRef(false);
  const [restarting, setRestarting] = useState(false);
  const [restartFailed, setRestartFailed] = useState(false);
  const restart = (mode: AgentRestartMode) => {
    if (!onRestart || restartInFlight.current) return;
    restartInFlight.current = true;
    setRestarting(true);
    setRestartFailed(false);

    const recover = () => {
      restartInFlight.current = false;
      setRestarting(false);
      setRestartFailed(true);
    };
    try {
      void Promise.resolve(onRestart(mode)).catch(recover);
    } catch {
      recover();
    }
  };
  // Inline rename of the header title ([F11]).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const commitRename = () => {
    onRename(draft.trim());
    setEditing(false);
  };
  // The context meter belongs on a LIVE pane only — a frozen, undimmed ctx% on
  // an exited / dormant / unavailable / provisioning pane would read as live
  // (its last usage report lingers in the store until the pane leaves the deck).
  const paneLive =
    !exit && !dormant && !provisioning && !unavailableAgent && !planPending;
  return (
    <section
      data-pane-id={paneId}
      tabIndex={-1}
      className={`pane${hidden ? " pane--hidden" : ""}${folded ? " pane--folded" : ""}${selected && !focused && !solo ? " pane--active" : ""}`}
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
      <header className="pane__bar" onClick={folded ? onSelect : undefined}>
        {folded && (
          // The accessible expand handle (the header click is the pointer
          // convenience around it).
          <button
            type="button"
            className="pane__fold-chevron"
            aria-expanded={false}
            aria-label={`Expand ${title}`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
          >
            <ChevronDownIcon />
          </button>
        )}
        <div className="pane__identity">
          <span className="pane__agent" title={agentLabel}>
            <AgentGlyph icon={agentIcon} />
          </span>
          {editing ? (
            <input
              {...noAutoCorrect}
              className="pane__rename"
              value={draft}
              autoFocus
              aria-label="Rename agent"
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                else if (e.key === "Escape") setEditing(false);
              }}
            />
          ) : (
            <span
              className="pane__title"
              title="Double-click to rename"
              onDoubleClick={() => {
                setDraft(title);
                setEditing(true);
              }}
            >
              {title}
            </span>
          )}
        </div>
        <div className="pane__actions">
          {ctxPct !== undefined && paneLive && (
            <Chip
              className={`pane__ctx${
                contextLevel(ctxPct) === "ok"
                  ? ""
                  : ` usage-level--${contextLevel(ctxPct)}`
              }`}
              title={`Context ${Math.ceil(ctxPct)}% used`}
              label={`ctx ${Math.ceil(ctxPct)}%`}
            />
          )}
          {yolo && (
            <Chip
              tone="warn"
              className="pane__yolo"
              icon={<BoltIcon />}
              role="img"
              aria-label="YOLO mode"
              title="YOLO mode — runs without permission prompts"
            />
          )}
          {gitBadge && (
            <Chip
              className="pane__branch"
              icon={<GitBranchIcon />}
              title={gitBadge.title}
              label={gitBadge.label}
            />
          )}
          {onMinimize && !focused && !folded && (
            <button
              type="button"
              // The modifier is load-bearing: the narrow-header cascade hides
              // minimize by this class (pane.css) while maximize stays.
              className="pane__action pane__action--minimize"
              onClick={onMinimize}
              title="Minimize agent"
              aria-label={`Minimize ${title}`}
            >
              <MinimizeIcon />
            </button>
          )}
          {!solo && !folded && (
            <button
              type="button"
              className="pane__action"
              onClick={onToggleFocus}
              title={focused ? "Restore" : "Maximize"}
              aria-label={focused ? `Restore ${title}` : `Maximize ${title}`}
            >
              {focused ? <RestoreIcon /> : <MaximizeIcon />}
            </button>
          )}
          <CloseButton
            label={`Close ${title}`}
            onClick={(e) => {
              // Own click: closing a folded row must not also expand it.
              e.stopPropagation();
              onClose();
            }}
          />
        </div>
      </header>
      <div className="pane__body">
        {provisioning ? (
          // The worktree behind this pane is still being created (or failed):
          // a status card instead of a terminal — mounting one now would
          // spawn the agent into somebody else's directory.
          provisioning.error ? (
            <div className="pane__dormant" role="alert">
              <span className="pane__exit-title">Worktree failed</span>
              <span
                className="pane__exit-sub pane__dormant-path"
                title={provisioning.error}
              >
                {provisioning.error}
              </span>
              {onRetryProvision && (
                <button
                  type="button"
                  className="pane__dormant-action"
                  onClick={onRetryProvision}
                >
                  Retry
                </button>
              )}
            </div>
          ) : (
            <div className="pane__dormant" role="status">
              <LaunchSpinner />
              <span className="pane__exit-title">
                {provisioning.phase === "setup"
                  ? "Running setup…"
                  : "Creating worktree…"}
              </span>
              <ProvisionLocation provisioning={provisioning} />
            </div>
          )
        ) : unavailableAgent ? (
          // No plugin provides this pane's agent (disabled or uninstalled).
          // The pane keeps its identity and session binding; the revive
          // effect skips it, and re-enabling the plugin brings it back live.
          <div className="pane__dormant" role="alert">
            <span className="pane__exit-title">Agent unavailable</span>
            <span
              className="pane__exit-sub pane__dormant-path"
              title={unavailableAgent}
            >
              No plugin provides “{unavailableAgent}” — enable it in Settings
              → Plugins
            </span>
          </div>
        ) : dormant ? (
          // Restored, no PTY behind it ([F7]). Normally transient (the revive
          // effect wakes active-workspace panes); it persists only when the
          // pane's directory is gone.
          <div className="pane__dormant" role="status">
            {blockedDir ? (
              <>
                <span className="pane__exit-title">Folder is gone</span>
                <span className="pane__exit-sub pane__dormant-path" title={blockedDir}>
                  {blockedDir}
                </span>
                {onStartFresh && (
                  <button
                    type="button"
                    className="pane__dormant-action"
                    onClick={onStartFresh}
                  >
                    Start fresh in the workspace folder
                  </button>
                )}
              </>
            ) : (
              <span className="pane__exit-title">Waking up…</span>
            )}
          </div>
        ) : planError ? (
          // The spawn plan FAILED to build (e.g. a remote spawn.plan threw).
          // The pane would otherwise hang on "Waking up…" forever — surface
          // the failure and offer a retry (drops it + re-runs the build).
          <div className="pane__dormant" role="status">
            <span className="pane__exit-title">Couldn't start this agent</span>
            <span className="pane__exit-sub">
              Its spawn plan failed to build — see the log for details.
            </span>
            {onRetryPlan && (
              <button
                type="button"
                className="pane__dormant-action"
                onClick={onRetryPlan}
              >
                Try again
              </button>
            )}
          </div>
        ) : planPending ? (
          // The spawn plan is a beat away (async plugin hooks) — same quiet
          // tile as a waking pane; it resolves within milliseconds.
          <div className="pane__dormant" role="status">
            <span className="pane__exit-title">Waking up…</span>
          </div>
        ) : (
          <TerminalPane
            paneId={paneId}
            command={command}
            args={args}
            env={env}
            envDefaults={envDefaults}
            cwd={cwd}
            visible={visible}
            selected={selected}
            onExit={(code, replayed) => {
              setExit({ code });
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
        )}
        {exit && !dormant && !unavailableAgent && (
          <div className="pane__exit" role="status">
            <span className="pane__exit-title">Agent exited</span>
            <span className="pane__exit-sub">
              {exit.code !== null ? `exit code ${exit.code}` : "terminated"}
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

/** The creating card's location line: "branch · path" from what the intent
 * knows (the batch flow auto-names its branch on the Rust side, so it may
 * only have the base folder). */
function ProvisionLocation({
  provisioning,
}: {
  provisioning: PaneProvisioning;
}) {
  const location = [provisioning.branch, provisioning.path ?? provisioning.baseDir]
    .filter(Boolean)
    .join(" · ");
  if (!location) return null;
  return (
    <span className="pane__exit-sub pane__dormant-path" title={location}>
      {location}
    </span>
  );
}
