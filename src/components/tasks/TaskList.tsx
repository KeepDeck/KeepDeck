import { VirtualList } from "@keepdeck/ui-kit/VirtualList";
import type { TaskStatus } from "../../domain/tasks";
import {
  headingOf,
  listHeadingClassName,
  listItemEstimate,
  listItemKey,
  type ListHeading,
  type ListItem,
} from "../../presentation/tasks";

interface TaskListProps {
  items: ListItem[];
  /** The open task's row, kept in view as J / K move it. */
  openId: string | null;
  onSelect(id: string): void;
  onFold(status: TaskStatus): void;
  /** A label clicked on a row: narrow the view to it. */
  onLabel(label: string): void;
}

/** The tracker's list view: a heading per status — pinned while its rows
 * scroll — and one line per task. Windowed, like the board's columns. */
export function TaskList({ items, openId, onSelect, onFold, onLabel }: TaskListProps) {
  return (
    <VirtualList
      items={items}
      itemKey={listItemKey}
      estimate={listItemEstimate}
      className="tasks__list"
      item={{ className: "tasks__list-item" }}
      revealKey={openId}
      sticky={{
        className: "tasks__list-pinned",
        render: (first) => {
          const heading = headingOf(items, first);
          return heading && <GroupHeading heading={heading} onFold={onFold} />;
        },
      }}
      render={(item) =>
        item.kind === "head" ? (
          <GroupHeading heading={item} onFold={onFold} />
        ) : (
          // The row is not itself a button: its labels and blockers are
          // controls of their own. Its open control spans it, under them.
          <div className={item.className}>
            <button
              type="button"
              className="tasks__row-open"
              aria-pressed={item.open}
              aria-label={`${item.card.id} ${item.card.title}`}
              onClick={() => onSelect(item.card.id)}
            />
            <span className="tasks__mark tasks__row-mark">{item.card.priority}</span>
            <span className={item.card.ring.className} title={item.card.ring.label} aria-hidden />
            <code className="tasks__row-id">{item.card.id}</code>
            <span className="tasks__row-title kd-one-line">{item.card.title}</span>
            {item.card.labels.map((label) => (
              <button key={label} type="button" className="tasks__label tasks__row-control" onClick={() => onLabel(label)}>
                {label}
              </button>
            ))}
            {item.card.blockerChips.map((chip) => (
              <button
                key={chip.id}
                type="button"
                className={`${chip.className} tasks__row-control`}
                title={chip.text}
                onClick={() => onSelect(chip.id)}
              >
                {chip.id}
              </button>
            ))}
            <span className="tasks__row-who">
              {item.card.initials && (
                <span className="tasks__avatar" aria-hidden>
                  {item.card.initials}
                </span>
              )}
              {item.card.assignee}
            </span>
            <span className="tasks__row-age">{item.card.age}</span>
          </div>
        )
      }
    />
  );
}

function GroupHeading({ heading, onFold }: { heading: ListHeading; onFold(status: TaskStatus): void }) {
  return (
    <button
      type="button"
      className={listHeadingClassName(heading)}
      aria-expanded={!heading.folded}
      onClick={() => onFold(heading.status)}
    >
      <span className={heading.ringClassName} aria-hidden />
      <span className="tasks__group-label">{heading.label}</span>
      <span className="tasks__group-count">{heading.count}</span>
    </button>
  );
}
