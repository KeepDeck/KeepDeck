/** A workspace groups a fleet of agents. (Pane isolation per workspace is a
 * later feature; for now the rail is the binding left-column layout.) */
export interface Workspace {
  id: string;
  name: string;
  agentCount: number;
}

interface WorkspacesRailProps {
  workspaces: Workspace[];
  activeId: string;
  onSelect(id: string): void;
  onAdd(): void;
}

/** Left rail listing workspaces with their agent counts; the active one is
 * highlighted. Mirrors the reference layout's left column. */
export function WorkspacesRail({
  workspaces,
  activeId,
  onSelect,
  onAdd,
}: WorkspacesRailProps) {
  return (
    <nav className="rail" aria-label="Workspaces">
      <div className="rail__head">
        <span className="rail__title">Workspaces</span>
        <button
          type="button"
          className="rail__add"
          onClick={onAdd}
          title="Add workspace"
          aria-label="Add workspace"
        >
          +
        </button>
      </div>
      <ul className="rail__list">
        {workspaces.map((ws) => {
          const active = ws.id === activeId;
          return (
            <li key={ws.id}>
              <button
                type="button"
                className={`rail__item${active ? " rail__item--active" : ""}`}
                onClick={() => onSelect(ws.id)}
                aria-current={active}
              >
                <span className="rail__dot" />
                <span className="rail__name">{ws.name}</span>
                <span className="rail__count">{ws.agentCount}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
