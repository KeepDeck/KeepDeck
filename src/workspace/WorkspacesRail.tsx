import { useState } from "react";

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
  onRename(id: string, name: string): void;
}

/** Left rail listing workspaces with their agent counts. The active one is
 * highlighted and shows a × (also on hover); double-clicking a name renames it. */
export function WorkspacesRail({
  workspaces,
  activeId,
  onSelect,
  onAdd,
  onClose,
  onRename,
}: WorkspacesRailProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const startEdit = (item: WorkspaceItem) => {
    setEditingId(item.id);
    setDraft(item.name);
  };
  const commitEdit = () => {
    if (editingId) {
      const name = draft.trim();
      if (name) onRename(editingId, name);
    }
    setEditingId(null);
  };

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
          if (ws.id === editingId) {
            return (
              <li key={ws.id} className="rail__item">
                <input
                  className="rail__rename"
                  value={draft}
                  autoFocus
                  aria-label="Workspace name"
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitEdit();
                    else if (e.key === "Escape") setEditingId(null);
                  }}
                />
              </li>
            );
          }
          return (
            <li
              key={ws.id}
              className={`rail__item${active ? " rail__item--active" : ""}`}
            >
              <button
                type="button"
                className="rail__select"
                onClick={() => onSelect(ws.id)}
                onDoubleClick={() => startEdit(ws)}
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
