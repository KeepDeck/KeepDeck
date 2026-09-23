import { taskCardClassName, type CardGrip, type TaskCardView } from "../../presentation/tasks";

interface TaskCardProps {
  card: TaskCardView;
  selected: boolean;
  /** Whether this card is the one in flight. */
  dragging?: boolean;
  onSelect(id: string): void;
  /** Present where a card may be dragged (the board); absent on the ghost.
   * A press arms a drag; the hook decides when it becomes one. */
  onArm?(id: string, x: number, y: number, grip: CardGrip): void;
}

/** One task on the board. The card IS the control — a list
 * row is one of the archetypes the shared Button deliberately does not
 * cover, so it is spelled here and dressed by its column. */
export function TaskCard({ card, selected, dragging = false, onSelect, onArm }: TaskCardProps) {
  return (
    <button
      type="button"
      className={taskCardClassName(card, { dragging, grabbable: onArm !== undefined })}
      aria-pressed={selected}
      onPointerDown={
        onArm
          ? (event) => {
              if (event.button !== 0) return;
              const rect = event.currentTarget.getBoundingClientRect();
              onArm(card.id, event.clientX, event.clientY, {
                width: rect.width,
                offsetX: event.clientX - rect.left,
                offsetY: event.clientY - rect.top,
              });
            }
          : undefined
      }
      onClick={() => onSelect(card.id)}
    >
      <span className="tasks__card-title kd-one-line">{card.title}</span>
      <span className="tasks__card-meta">
        <code>{card.meta}</code>
        {card.priority && <span className="tasks__mark">{card.priority}</span>}
      </span>
      {card.blockedBy && <span className="tasks__card-blocked">{card.blockedBy}</span>}
    </button>
  );
}
