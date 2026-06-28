import { TerminalPane } from "../terminal/TerminalPane";

interface AgentPaneProps {
  title: string;
  /** Program to run; omitted/null spawns the user's shell. */
  command?: string | null;
  /** Whether this pane is currently on screen. */
  visible: boolean;
  /** Whether this pane is maximized to fill the grid. */
  focused: boolean;
  /** Whether this pane is hidden because another pane is maximized. */
  collapsed: boolean;
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
  visible,
  focused,
  collapsed,
  onToggleFocus,
  onClose,
}: AgentPaneProps) {
  return (
    <section className={`pane${collapsed ? " pane--collapsed" : ""}`}>
      <header className="pane__bar">
        <span className="pane__title">{title}</span>
        <div className="pane__actions">
          <button
            type="button"
            className="pane__action"
            onClick={onToggleFocus}
            title={focused ? "Restore" : "Maximize"}
            aria-label={focused ? `Restore ${title}` : `Maximize ${title}`}
          >
            {focused ? "▢" : "⤢"}
          </button>
          <button
            type="button"
            className="pane__close"
            onClick={onClose}
            title="Close agent"
            aria-label={`Close ${title}`}
          >
            ×
          </button>
        </div>
      </header>
      <div className="pane__body">
        <TerminalPane command={command} visible={visible} />
      </div>
    </section>
  );
}
