import type { TaskCardView } from "../../presentation/tasks";

interface TaskCardProps {
  card: TaskCardView;
  selected: boolean;
  onSelect(id: string): void;
}

/** One task on the board or in a lane. The card IS the control — a list
 * row is one of the archetypes the shared Button deliberately does not
 * cover, so it is spelled here and dressed by its column. */
export function TaskCard({ card, selected, onSelect }: TaskCardProps) {
  return (
    <button
      type="button"
      className={`tasks__card tasks__card--${card.tone}${card.cancelled ? " tasks__card--cancelled" : ""}`}
      aria-pressed={selected}
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
