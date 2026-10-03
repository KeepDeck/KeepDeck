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
import { TaskLabels } from "./TaskLabels";

interface TaskListProps {
  items: ListItem[];
  onSelect(id: string): void;
  onFold(status: TaskStatus): void;
}

/** The tracker's list view: a heading per status — pinned while its rows
 * scroll — and one line per task. Windowed, like the board's columns. */
export function TaskList({ items, onSelect, onFold }: TaskListProps) {
  return (
    <VirtualList
      items={items}
      itemKey={listItemKey}
      estimate={listItemEstimate}
      className="tasks__list"
      item={{ className: "tasks__list-item" }}
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
          <button
            type="button"
            className={item.className}
            aria-pressed={item.open}
            onClick={() => onSelect(item.card.id)}
          >
            <span className="tasks__mark tasks__row-mark">{item.card.priority}</span>
            <span className="tasks__row-title kd-one-line">{item.card.title}</span>
            {item.card.labels.length > 0 && <TaskLabels labels={item.card.labels} />}
            {item.card.blockedBy && <span className="tasks__row-blocked kd-one-line">{item.card.blockedBy}</span>}
            <code className="tasks__row-meta">{item.card.meta}</code>
          </button>
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
      <span className="tasks__group-label">{heading.label}</span>
      <span className="tasks__group-count">{heading.count}</span>
    </button>
  );
}
