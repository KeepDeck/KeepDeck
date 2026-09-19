import type { TaskCardView } from "../../presentation/tasks";

interface TaskCardProps {
  card: TaskCardView;
  selected: boolean;
  /** Whether this card is the one in flight. */
  dragging?: boolean;
  onSelect(id: string): void;
  /** Present where a card may be dragged (the board); absent in a lane. */
  onDragStart?(id: string): void;
  onDragEnd?(): void;
}

/** One task on the board or in a lane. The card IS the control — a list
 * row is one of the archetypes the shared Button deliberately does not
 * cover, so it is spelled here and dressed by its column. */
export function TaskCard({ card, selected, dragging = false, onSelect, onDragStart, onDragEnd }: TaskCardProps) {
  const draggable = onDragStart !== undefined;
  return (
    <button
      type="button"
      className={`tasks__card tasks__card--${card.tone}${card.cancelled ? " tasks__card--cancelled" : ""}${dragging ? " tasks__card--dragging" : ""}`}
      aria-pressed={selected}
      draggable={draggable}
      onDragStart={
        draggable
          ? (event) => {
              if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", card.id);
              }
              onDragStart(card.id);
            }
          : undefined
      }
      onDragEnd={onDragEnd}
      onClick={() => onSelect(card.id)}
    >
      <span className="tasks__card-title">{card.title}</span>
      <span className="tasks__card-meta">
        <code>{card.meta}</code>
        {card.priority && <span className="tasks__mark">{card.priority}</span>}
      </span>
      {card.blockedBy && <span className="tasks__card-blocked">{card.blockedBy}</span>}
    </button>
  );
}
