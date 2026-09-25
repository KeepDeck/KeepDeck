import type { BoardColumnView } from "../../presentation/tasks";
import { columnClassName, type CardGrip, type DragState } from "../../presentation/tasks";
import type { TaskStatus } from "../../domain/tasks";
import { TaskCard } from "./TaskCard";

interface BoardColumnsProps {
  columns: BoardColumnView[];
  selectedId: string | null;
  drag: DragState;
  /** The column the pointer is over while a card is in flight. */
  hover: TaskStatus | null;
  onSelect(id: string): void;
  onArm(id: string, x: number, y: number, grip: CardGrip): void;
  onHover(status: TaskStatus | null): void;
  onDrop(status: TaskStatus): void;
}

export function BoardColumns({
  columns,
  selectedId,
  drag,
  hover,
  onSelect,
  onArm,
  onHover,
  onDrop,
}: BoardColumnsProps) {
  return (
    <div className="tasks__columns">
      {columns.map((column) => (
        <section
          key={column.status}
          className={columnClassName(column.status, drag, hover)}
          aria-label={column.label}
          data-drop-status={column.status}
          onPointerOver={() => onHover(column.status)}
          onPointerLeave={() => onHover(null)}
          onPointerUp={() => onDrop(column.status)}
        >
          <header className="tasks__column-head">
            <span className={`tasks__column-label tasks__column-label--${column.status}`}>{column.label}</span>
            <span className="tasks__column-count">{column.count}</span>
          </header>
          <div className="tasks__column-body">
            {column.cards.map((card) => (
              <TaskCard
                key={card.id}
                card={card}
                selected={card.id === selectedId}
                dragging={drag.kind === "dragging" && drag.id === card.id}
                onSelect={onSelect}
                onArm={onArm}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
