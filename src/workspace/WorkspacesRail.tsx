/** View model for the rail (the domain `Workspace` lives in `../workspaces`). */
export interface WorkspaceItem {
  id: string;
  name: string;
  agentCount: number;
}

interface WorkspacesRailProps {
  workspaces: WorkspaceItem[];
  activeId: string;
  onSelect(id: string): void;
  onAdd(): void;
  onClose(id: string): void;
}

/** Left rail listing workspaces with their agent counts; the active one is
 * highlighted and shows a × (also on hover) to close it. */
export function WorkspacesRail({
  workspaces,
  activeId,
  onSelect,
  onAdd,
  onClose,
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
            <li
              key={ws.id}
              className={`rail__item${active ? " rail__item--active" : ""}`}
            >
              <button
                type="button"
                className="rail__select"
                onClick={() => onSelect(ws.id)}
                aria-current={active}
              >
                <span className="rail__dot" />
                <span className="rail__name">{ws.name}</span>
              </button>
              <span className="rail__count">{ws.agentCount}</span>
              <button
                type="button"
                className="rail__close"
                onClick={() => onClose(ws.id)}
                title="Close workspace"
                aria-label={`Close ${ws.name}`}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
