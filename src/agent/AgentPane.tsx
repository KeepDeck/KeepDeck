import { TerminalPane } from "../terminal/TerminalPane";

interface AgentPaneProps {
  title: string;
  /** Program to run; omitted/null spawns the user's shell. */
  command?: string | null;
  /** Whether this pane's workspace is currently visible. */
  active: boolean;
  onClose(): void;
}

/**
 * One agent tile in the grid: a thin header (title + close) over a live
 * terminal pane. Status/telemetry on the header come with the observability
 * milestone.
 */
export function AgentPane({ title, command, active, onClose }: AgentPaneProps) {
  return (
    <section className="pane">
      <header className="pane__bar">
        <span className="pane__title">{title}</span>
        <button
          type="button"
          className="pane__close"
          onClick={onClose}
          title="Close agent"
          aria-label={`Close ${title}`}
        >
          ×
        </button>
      </header>
      <div className="pane__body">
        <TerminalPane command={command} active={active} />
      </div>
    </section>
  );
}
