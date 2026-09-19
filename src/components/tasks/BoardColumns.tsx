import type { BoardColumnView } from "../../presentation/tasks";
import type { TaskStatus } from "../../domain/tasks";
import { TaskCard } from "./TaskCard";

interface BoardColumnsProps {
  columns: BoardColumnView[];
  selectedId: string | null;
  /** The card in flight and where it may land, or null. */
  dragging: { id: string; targets: ReadonlySet<TaskStatus> } | null;
  onSelect(id: string): void;
  onToggleColumn(status: TaskStatus): void;
  onDragStart(id: string): void;
  onDragEnd(): void;
  onDrop(status: TaskStatus): void;
}

/** What a column is to a drag: a place it may land, one it may not, or
 * nothing while no card is in flight. */
function dropState(column: BoardColumnView, dragging: BoardColumnsProps["dragging"]): "ok" | "no" | null {
  if (dragging === null) return null;
  return dragging.targets.has(column.status) ? "ok" : "no";
}

export function BoardColumns({
  columns,
  selectedId,
  dragging,
  onSelect,
  onToggleColumn,
  onDragStart,
  onDragEnd,
  onDrop,
}: BoardColumnsProps) {
  return (
    <div className="tasks__columns">
      {columns.map((column) => {
        const drop = dropState(column, dragging);
        return (
        <section
          key={column.status}
          className={`tasks__column${column.collapsed ? " tasks__column--collapsed" : ""}${drop ? ` tasks__column--drop-${drop}` : ""}`}
          aria-label={column.label}
          onDragOver={(event) => {
            // Allowing the drop is what preventDefault means here; a
            // column that is not a target lets the browser refuse it.
            if (drop !== "ok") return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            event.preventDefault();
            onDrop(column.status);
          }}
        >
          <header className="tasks__column-head">
            <span className={`tasks__column-label tasks__column-label--${column.status}`}>{column.label}</span>
            <span className="tasks__column-count">{column.count}</span>
            {(column.status === "done" || column.status === "cancelled") && (
              <button type="button" className="tasks__column-toggle" onClick={() => onToggleColumn(column.status)}>
                {column.collapsed ? "Show" : "Hide"}
              </button>
            )}
          </header>
          {!column.collapsed && (
            <div className="tasks__column-body">
              {column.cards.map((card) => (
                <TaskCard
                  key={card.id}
                  card={card}
                  selected={card.id === selectedId}
                  dragging={dragging?.id === card.id}
                  onSelect={onSelect}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                />
              ))}
            </div>
          )}
        </section>
        );
      })}
    </div>
  );
}
