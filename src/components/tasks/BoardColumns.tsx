import type { BoardColumnView } from "../../presentation/tasks";
import type { TaskStatus } from "../../domain/tasks";
import { TaskCard } from "./TaskCard";

interface BoardColumnsProps {
  columns: BoardColumnView[];
  selectedId: string | null;
  onSelect(id: string): void;
  onToggleColumn(status: TaskStatus): void;
}

export function BoardColumns({ columns, selectedId, onSelect, onToggleColumn }: BoardColumnsProps) {
  return (
    <div className="tasks__columns">
      {columns.map((column) => (
        <section
          key={column.status}
          className={`tasks__column${column.collapsed ? " tasks__column--collapsed" : ""}`}
          aria-label={column.label}
        >
          <header className="tasks__column-head">
            <span className={`tasks__column-label tasks__column-label--${column.status}`}>{column.label}</span>
            <span className="tasks__column-count">{column.count}</span>
            {(column.status === "done" || column.status === "dropped") && (
              <button type="button" className="tasks__column-toggle" onClick={() => onToggleColumn(column.status)}>
                {column.collapsed ? "Show" : "Hide"}
              </button>
            )}
          </header>
          {!column.collapsed && (
            <div className="tasks__column-body">
              {column.cards.map((card) => (
                <TaskCard key={card.id} card={card} selected={card.id === selectedId} onSelect={onSelect} />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
