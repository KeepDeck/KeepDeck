import type { AgentInfo } from "../../domain/agents";
import type { SessionRecord } from "../../domain/journal";
import { formatAge } from "../../domain/usage/format";
import { AgentGlyph } from "../../ui/AgentGlyph";

interface WorkspaceHistoryProps {
  /** The workspace's journal, newest binding first (`journalRows`). */
  rows: SessionRecord[];
  agents: AgentInfo[];
  /** Forget one record — journal metadata only, the agent store is untouched. */
  onDelete(sessionId: string): void;
  /** Resume a closed record into a new pane of this workspace. */
  onResume(record: SessionRecord): void;
}

/**
 * Shown when a workspace has no panes: the sessions that ran here ([F8]).
 * Replaces the old batch count-picker — "+ Agent" in the top bar is the one
 * way to add an agent; this surface is for coming BACK to a workspace and
 * seeing what happened in it.
 */
export function WorkspaceHistory({ rows, agents, onDelete, onResume }: WorkspaceHistoryProps) {
  if (rows.length === 0) {
    return (
      <div className="history history--empty">
        <h2 className="history__title">No sessions yet</h2>
        <p className="history__hint">
          Add an agent with "+ Agent" — sessions that run here stay listed,
          ready to pick up later
        </p>
      </div>
    );
  }
  const now = Date.now();
  return (
    <div className="history">
      <h2 className="history__title">Sessions</h2>
      <ul className="history__list">
        {rows.map((row) => {
          const agent = agents.find((a) => a.id === row.agent);
          const when = row.state === "closed" ? row.endedAt : row.boundAt;
          return (
            <li key={row.sessionId} className="history__row">
              <span
                className={`history__state${
                  row.state === "live" ? " history__state--live" : ""
                }`}
                title={row.state === "live" ? "Running" : "Closed"}
              />
              <span className="history__glyph">
                <AgentGlyph icon={agent?.icon} />
              </span>
              <span className="history__name" title={row.sessionId}>
                {row.title ?? agent?.label ?? row.agent}
              </span>
              {row.branch !== undefined && (
                <span className="history__chip" title={row.cwd}>
                  {row.branch}
                </span>
              )}
              <span className="history__when">
                {formatAge(Date.parse(when), now)}
              </span>
              {row.state === "closed" && (
                <button
                  type="button"
                  className="history__resume"
                  title="Resume this session in a new pane"
                  onClick={() => onResume(row)}
                >
                  Resume
                </button>
              )}
              <button
                type="button"
                className="history__delete"
                aria-label="Forget session"
                title="Forget this session"
                onClick={() => onDelete(row.sessionId)}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
