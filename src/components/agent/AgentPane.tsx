import { useState } from "react";
import { TerminalPane } from "../terminal/TerminalPane";
import { noAutoCorrect } from "../../ui/inputProps";

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
  /** Git branch of the agent's worktree, shown in the header when isolated. */
  branch?: string | null;
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
  visible,
  focused,
  collapsed,
  selected,
  solo,
  dormant,
  blockedDir,
  colSpan,
  onSelect,
  onToggleFocus,
  onOpenInEditor,
  onClose,
  onRename,
  onTitle,
  onStartFresh,
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
        {cwd && (
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
          <span className="pane__branch" title={branch}>
            {branch}
          </span>
        )}
        <div className="pane__actions">
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
        {dormant ? (
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
            <span className="pane__exit-title">Agent exited</span>
            <span className="pane__exit-sub">
              {exit.code !== null ? `exit code ${exit.code}` : "terminated"}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

const iconProps = {
  viewBox: "0 0 24 24",
  width: 13,
  height: 13,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** Expand-to-fill (enter fullscreen). */
function MaximizeIcon() {
  return (
    <svg {...iconProps}>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

/** Restore / un-maximize — the conventional minimize glyph (a bottom bar),
 * clearly distinct from the expand arrows and easy to read. */
function RestoreIcon() {
  return (
    <svg {...iconProps}>
      <line x1="6" y1="18" x2="18" y2="18" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg {...iconProps}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
