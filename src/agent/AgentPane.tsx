import { TerminalPane } from "../terminal/TerminalPane";

interface AgentPaneProps {
  title: string;
  /** Program to run; omitted/null spawns the user's shell. */
  command?: string | null;
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
  /** Grid columns this pane spans (>1 lets a partial last row fill the width). */
  colSpan: number;
  onSelect(): void;
  onToggleFocus(): void;
  onClose(): void;
}

/**
 * One agent tile in the grid: a thin header (title + maximize + close) over a
 * live terminal pane. Status/telemetry on the header come with the
 * observability milestone.
 */
export function AgentPane({
  title,
  command,
  cwd,
  branch,
  visible,
  focused,
  collapsed,
  selected,
  solo,
  colSpan,
  onSelect,
  onToggleFocus,
  onClose,
}: AgentPaneProps) {
  return (
    <section
      className={`pane${collapsed ? " pane--collapsed" : ""}${selected && !focused && !solo ? " pane--active" : ""}`}
      style={colSpan > 1 ? { gridColumn: `span ${colSpan}` } : undefined}
      onMouseDown={onSelect}
      onFocus={onSelect}
    >
      <header className="pane__bar">
        <span className="pane__title">{title}</span>
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
        <TerminalPane
          command={command}
          cwd={cwd}
          visible={visible}
          selected={selected}
        />
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
