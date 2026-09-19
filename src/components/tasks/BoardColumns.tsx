import type { BoardColumnView } from "../../presentation/tasks";
import type { TaskStatus } from "../../domain/tasks";
import { TaskCard } from "./TaskCard";
import type { CardDrag } from "./useTasksBoard";

interface BoardColumnsProps {
  columns: BoardColumnView[];
  selectedId: string | null;
  /** The card in flight and where it may land, or null. */
  dragging: CardDrag | null;
  /** The column the pointer is over while a card is in flight. */
  hover: TaskStatus | null;
  onSelect(id: string): void;
  onToggleColumn(status: TaskStatus): void;
  onArm(id: string, x: number, y: number): void;
  onHover(status: TaskStatus | null): void;
  onDrop(status: TaskStatus): void;
}

/** What a column is to a drag: a place it may land, one it may not, or
 * nothing while no card is in flight. */
function dropState(column: BoardColumnView, dragging: CardDrag | null): "ok" | "no" | null {
  if (dragging === null) return null;
  return dragging.targets.has(column.status) ? "ok" : "no";
}

export function BoardColumns({
  columns,
  selectedId,
  dragging,
  hover,
  onSelect,
  onToggleColumn,
  onArm,
  onHover,
  onDrop,
}: BoardColumnsProps) {
  return (
    <div className="tasks__columns">
      {columns.map((column) => {
        const drop = dropState(column, dragging);
        const over = drop === "ok" && hover === column.status;
        return (
          <section
            key={column.status}
            className={`tasks__column${column.collapsed ? " tasks__column--collapsed" : ""}${drop ? ` tasks__column--drop-${drop}` : ""}${over ? " tasks__column--drop-over" : ""}`}
            aria-label={column.label}
            data-drop-status={column.status}
            onPointerOver={() => onHover(column.status)}
            onPointerLeave={() => onHover(null)}
            onPointerUp={() => onDrop(column.status)}
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
                    onArm={onArm}
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
