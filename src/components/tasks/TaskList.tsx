import type { PointerEvent } from "react";
import { DisclosureChevron } from "@keepdeck/ui-kit/DisclosureChevron";
import { StatusRing } from "@keepdeck/ui-kit/StatusRing";
import { VirtualList } from "@keepdeck/ui-kit/VirtualList";
import { EpicBar, EpicChip } from "./EpicMarks";
import type { TaskStatus } from "../../domain/tasks";
import {
  headingOf,
  isListHeading,
  listHeadingDropClassName,
  listRowClassName,
  armsOn,
  rowGrip,
  LIST_HEAD_ESTIMATE_PX,
  listItemEstimate,
  listItemKey,
  type RowGrip,
  type DragState,
  type ListHeading,
  type ListItem,
  type TaskRowView,
} from "../../presentation/tasks";

interface TaskListProps {
  items: ListItem[];
  /** The drag in flight: a row is picked up, and a group — its heading or
   * any of its rows — is a drop target. */
  drag: DragState;
  /** The group the pointer is over while a task is in flight. */
  hover: TaskStatus | null;
  onArm(id: string, x: number, y: number, grip: RowGrip): void;
  onHover(status: TaskStatus | null): void;
  onDrop(status: TaskStatus): void;
  /** The open task's row, kept in view as J / K move it. */
  openId: string | null;
  onSelect(id: string): void;
  onFold(status: TaskStatus): void;
  /** An epic's chevron: its tasks folded away, or shown. */
  onFoldEpic(id: string): void;
  /** A label clicked on a row: narrow the view to it. */
  onLabel(label: string): void;
  /** The person's folds, of groups and of epics, as one token: a change of
   * it, and only that, eases the list and holds the folded row in place
   * (VirtualList easeKey). Only the person's folds write it. */
  folds: unknown;
}

/** The tracker's list: a heading per status — pinned while its rows
 * scroll — and one line per task. Windowed. */
export function TaskList({ items, openId, drag, hover, folds, onSelect, onFold, onFoldEpic, onLabel, onArm, onHover, onDrop }: TaskListProps) {
  // A group answers the pointer wherever it is under it: its heading, or
  // one of its rows.
  const dropTarget = (status: TaskStatus) => ({
    onPointerOver: () => onHover(status),
    onPointerLeave: () => onHover(null),
    onPointerUp: () => onDrop(status),
  });
  return (
    <VirtualList
      items={items}
      itemKey={listItemKey}
      estimate={listItemEstimate}
      className="tasks__list"
      item={{ className: "tasks__list-item" }}
      revealKey={openId}
      easeKey={folds}
      sticky={{
        className: "tasks__list-pinned",
        height: LIST_HEAD_ESTIMATE_PX,
        heads: isListHeading,
        // The pinned heading stands over the group's own: it takes a drop
        // as the group does, and is the pointer's alone — the real heading
        // is the one the keyboard and a reader reach, never a second.
        render: (first) => {
          const heading = headingOf(items, first);
          return (
            heading && (
              <GroupHeading
                // A status's own button: scrolled to another group under a
                // still pointer, the heading is a new element, not this
                // one relabelled with the old group's hover.
                key={heading.status}
                heading={heading}
                className={listHeadingDropClassName(heading, drag, hover)}
                onFold={onFold}
                pinned
                {...dropTarget(heading.status)}
              />
            )
          );
        },
      }}
      render={(item) =>
        item.kind === "head" ? (
          <GroupHeading
            heading={item}
            className={listHeadingDropClassName(item, drag, hover)}
            onFold={onFold}
            {...dropTarget(item.status)}
          />
        ) : (
          // The house row (the artifacts dialog's): the row's own control
          // opens it, and its labels and blockers are controls BESIDE it —
          // never a button inside a button, never one laid under another.
          <div
            className={listRowClassName(item, drag, hover)}
            {...dropTarget(item.status)}
          >
            {/* Every row leads with its gutter: an epic's fold is a control
                of its own there, beside the row's — never a button inside a
                button; any other row's gutter is a picture. */}
            {item.fold ? (
              <button
                type="button"
                className="tasks__row-lead tasks__row-fold tasks__row-control"
                aria-expanded={!item.fold.folded}
                aria-label={item.fold.label}
                title={item.fold.label}
                onClick={() => onFoldEpic(item.line.id)}
              >
                <DisclosureChevron open={!item.fold.folded} />
              </button>
            ) : (
              <span className={item.leadClassName} aria-hidden />
            )}
            <TaskRowLine
              line={item.line}
              open={{
                pressed: item.open,
                onPointerDown: (event) => {
                  if (!armsOn(event.button)) return;
                  // The ghost is the row whole: measured from the row, not
                  // from its open control.
                  const row = event.currentTarget.parentElement ?? event.currentTarget;
                  onArm(item.line.id, event.clientX, event.clientY, rowGrip(row.getBoundingClientRect(), event.clientX, event.clientY));
                },
                onClick: () => onSelect(item.line.id),
              }}
              onLabel={onLabel}
              onSelect={onSelect}
            />
          </div>
        )
      }
    />
  );
}

function GroupHeading({
  heading,
  className,
  onFold,
  pinned = false,
  ...drop
}: {
  heading: ListHeading;
  className: string;
  onFold(status: TaskStatus): void;
  pinned?: boolean;
  onPointerOver?(): void;
  onPointerLeave?(): void;
  onPointerUp?(): void;
}) {
  return (
    <button
      type="button"
      {...drop}
      className={className}
      aria-expanded={pinned ? undefined : !heading.folded}
      aria-hidden={pinned || undefined}
      tabIndex={pinned ? -1 : undefined}
      onClick={() => onFold(heading.status)}
    >
      <DisclosureChevron open={!heading.folded} />
      <StatusRing {...heading.ring} />
      <span className="tasks__group-label">{heading.label}</span>
      <span className="tasks__group-count">{heading.count}</span>
    </button>
  );
}

/**
 * What a row shows, in its columns: priority, status, id, title, labels,
 * what holds it, who has it, how long since it moved. The list draws it
 * with its labels and blockers as controls; the drag's ghost draws the
 * same line as a picture (no handlers) — the row in flight IS the row.
 */
export function TaskRowLine({
  line,
  open,
  onLabel,
  onSelect,
}: {
  line: TaskRowView;
  /** The row's own control — absent on the ghost, a picture. */
  open?: {
    pressed: boolean;
    onPointerDown(event: PointerEvent<HTMLButtonElement>): void;
    onClick(): void;
  };
  onLabel?(label: string): void;
  onSelect?(id: string): void;
}) {
  const head = (
    <>
      <span className="tasks__mark tasks__row-mark">{line.priority}</span>
      <StatusRing {...line.ring} />
      <code className="tasks__row-id">{line.id}</code>
      {line.epic && <EpicChip text={line.epic.chip} />}
      <span className="tasks__row-title" dir="auto">
        {line.title}
      </span>
    </>
  );
  return (
    <>
      {open ? (
        <button
          type="button"
          className="tasks__row-open"
          aria-pressed={open.pressed}
          onPointerDown={open.onPointerDown}
          onClick={open.onClick}
        >
          {head}
        </button>
      ) : (
        <span className="tasks__row-open">{head}</span>
      )}
      {line.labels.map((label) =>
        onLabel ? (
          <button key={label} type="button" className="kd-tag tasks__row-control" onClick={() => onLabel(label)}>
            {label}
          </button>
        ) : (
          <span key={label} className="kd-tag">
            {label}
          </span>
        ),
      )}
      {line.blockerChips.map((chip) =>
        onSelect ? (
          <button
            key={chip.id}
            type="button"
            className={`${chip.className} tasks__row-control`}
            title={chip.text}
            onClick={() => onSelect(chip.id)}
          >
            {chip.id}
          </button>
        ) : (
          <span key={chip.id} className={chip.className}>
            {chip.id}
          </span>
        ),
      )}
      {line.epic && (
        <span className="tasks__epic-progress" title={line.epic.label}>
          <EpicBar fill={line.epic.fill} />
          <span aria-label={line.epic.label}>{line.epic.count}</span>
        </span>
      )}
      <span className="tasks__row-who">{line.assignee}</span>
      <span className="tasks__row-age">{line.age}</span>
    </>
  );
}
