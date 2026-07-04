import { useState } from "react";
import type { PaneProvisioning } from "../../domain/panes";
import { TerminalPane } from "../terminal/TerminalPane";
import { noAutoCorrect } from "../../ui/inputProps";
import { CloseIcon, MaximizeIcon, PlayIcon, RestoreIcon } from "../../ui/icons";

interface AgentPaneProps {
  /** Pane id — used for drag-and-drop hit-testing ([F4], `data-pane-id`). */
  paneId: string;
  title: string;
  /** Program to run; omitted/null spawns the user's shell. */
  command?: string | null;
  /** Extra CLI args for the program (session identity / resume, [F7]/[F8]). */
  args?: string[];
  /** Extra environment for the program (reporter activation, [F7]/[F8]). */
  env?: [string, string][];
  /** Working directory for the session. */
  cwd?: string | null;
  /** Badge label for the agent's git position — its worktree branch, or a
   * short commit id when detached. Kept live by the HEAD watcher. */
  branch?: string | null;
  /** Full form for the badge tooltip (full branch name / full commit SHA). */
  branchTitle?: string | null;
  /** Whether this pane is currently on screen. */
  visible: boolean;
  /** Whether this pane is maximized to fill the grid. */
  focused: boolean;
  /** Whether this pane is hidden because another pane is maximized. */
  collapsed: boolean;
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
  /** Re-issue the failed create from its stored intent. */
  onRetryProvision?(): void;
  /** Set = this is a run pane executing this command (experimental run
   * presets); shapes the dormant tile ("Run" instead of auto-wake) and the
   * exit card ("Run again"). */
  runCommand?: string | null;
  /** Open the run-preset picker for this pane's worktree — the header ▶.
   * Absent = hidden (experiment off, at the pane cap, or a run pane). */
  onRunPreset?(): void;
  /** (Re)run a run pane's command — the dormant tile and the exit card. */
  onRunAgain?(): void;
  /** Grid columns this pane spans (>1 lets a partial last row fill the width). */
  colSpan: number;
  onSelect(): void;
  onToggleFocus(): void;
  /** Open the agent's working dir in VS Code; shown only when a `cwd` is known. */
  onOpenInEditor(): void;
  onClose(): void;
  /** Set a manual name ([F11]); an empty name reverts to auto/derived. */
  onRename(name: string): void;
  /** Terminal title changed (OSC) — feeds auto-naming ([F11]). */
  onTitle(title: string): void;
}

/**
 * One agent tile in the grid: a thin header (title + maximize + close) over a
 * live terminal pane. Status/telemetry on the header come with the
 * observability milestone.
 */
export function AgentPane({
  paneId,
  title,
  command,
  args,
  env,
  cwd,
  branch,
  branchTitle,
  visible,
  focused,
  collapsed,
  selected,
  solo,
  dormant,
  blockedDir,
  provisioning,
  colSpan,
  onSelect,
  onToggleFocus,
  onOpenInEditor,
  onClose,
  onRename,
  onTitle,
  onStartFresh,
  onRetryProvision,
  runCommand,
  onRunPreset,
  onRunAgain,
}: AgentPaneProps) {
  // The PTY process has exited (terminal end-state); shows the [U4] placeholder.
  const [exit, setExit] = useState<{ code: number | null } | null>(null);
  // Inline rename of the header title ([F11]).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const commitRename = () => {
    onRename(draft.trim());
    setEditing(false);
  };
  // The exit card must not survive into the fresh session a re-run spawns.
  const runAgain = () => {
    setExit(null);
    onRunAgain?.();
  };
  return (
    <section
      data-pane-id={paneId}
      className={`pane${collapsed ? " pane--collapsed" : ""}${selected && !focused && !solo ? " pane--active" : ""}`}
      style={colSpan > 1 ? { gridColumn: `span ${colSpan}` } : undefined}
      onMouseDown={onSelect}
      onFocus={onSelect}
    >
      <header className="pane__bar">
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
        {cwd && !provisioning && (
          // Hidden while provisioning: the pane has no directory of its own
          // yet, and the fallback cwd would open the wrong folder.
          <button
            type="button"
            className="pane__open"
            onClick={onOpenInEditor}
            title="Open this agent's working directory in VS Code"
          >
            Open in VSCode
          </button>
        )}
        {branch && (
          <span className="pane__branch" title={branchTitle ?? branch}>
            {branch}
          </span>
        )}
        <div className="pane__actions">
          {onRunPreset && (
            <button
              type="button"
              className="pane__action"
              onClick={onRunPreset}
              title="Run a preset in this agent's folder"
              aria-label={`Run a preset next to ${title}`}
            >
              <PlayIcon />
            </button>
          )}
          {!solo && (
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
          <button
            type="button"
            className="pane__close"
            onClick={onClose}
            title="Close agent"
            aria-label={`Close ${title}`}
          >
            <CloseIcon />
          </button>
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
              <span className="pane__provision-bar" aria-hidden />
              <span className="pane__provision-pulse" aria-hidden>
                <span />
                <span />
                <span />
              </span>
              <span className="pane__exit-title">
                {provisioning.phase === "setup"
                  ? "Running setup…"
                  : "Creating worktree…"}
              </span>
              <ProvisionLocation provisioning={provisioning} />
            </div>
          )
        ) : dormant ? (
          // Restored, no PTY behind it ([F7]). Normally transient (the revive
          // effect wakes active-workspace panes); it persists only when the
          // pane's directory is gone — or for a run pane, which never
          // auto-starts and waits for an explicit Run.
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
            ) : runCommand ? (
              <>
                <span className="pane__exit-title">Not running</span>
                <span
                  className="pane__exit-sub pane__dormant-path"
                  title={runCommand}
                >
                  {runCommand}
                </span>
                {onRunAgain && (
                  <button
                    type="button"
                    className="pane__dormant-action"
                    onClick={runAgain}
                  >
                    Run
                  </button>
                )}
              </>
            ) : (
              <span className="pane__exit-title">Waking up…</span>
            )}
          </div>
        ) : (
          <TerminalPane
            paneId={paneId}
            command={command}
            args={args}
            env={env}
            cwd={cwd}
            visible={visible}
            selected={selected}
            onExit={(code) => setExit({ code })}
            onTitle={onTitle}
          />
        )}
        {exit && !dormant && (
          <div className="pane__exit" role="status">
            <span className="pane__exit-title">
              {runCommand ? "Command exited" : "Agent exited"}
            </span>
            <span className="pane__exit-sub">
              {exit.code !== null ? `exit code ${exit.code}` : "terminated"}
            </span>
            {runCommand && onRunAgain && (
              <button
                type="button"
                className="pane__dormant-action pane__exit-action"
                onClick={runAgain}
              >
                Run again
              </button>
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

