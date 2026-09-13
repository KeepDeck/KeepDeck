import { useEffect, useRef, type ReactNode } from "react";
import { useRowWindow } from "./useRowWindow";

/** The elements a consumer's list is made of, when the defaults (plain
 * divs) are not its markup: a `ul` spacer with `li` items keeps a list a
 * list for the stylesheet and the accessibility tree. */
export interface VirtualListMarkup {
  /** The spacer the items are positioned in. */
  spacer?: { as?: "div" | "ul"; className?: string };
  /** The box around each item — the one the list positions and
   * measures. Its class is the consumer's: padding inside it is part of
   * the measured height, a margin would not be. */
  item?: { as?: "div" | "li"; className?: string };
}

export interface VirtualListProps<T> extends VirtualListMarkup {
  items: readonly T[];
  /** A stable identity per item — never the index (see `useRowWindow`). */
  itemKey: (item: T) => string;
  /** The first paint's guess at an item's height, in pixels; corrected
   * by measurement the moment the row reports its real box. */
  estimate: number | ((item: T) => number);
  /** The item's content. The list positions and measures the box around
   * it, so the content takes no position of its own. */
  render: (item: T, index: number) => ReactNode;
  /** The scroll container's class — the consumer's, styled by it. */
  className: string;
  role?: string;
  ariaLabel?: string;
  /** Called when the window reaches the last item — the hook for a list
   * that grows as it is scrolled. */
  onReachEnd?: () => void;
}

/**
 * The windowed list as a component: the scroll container, a spacer the
 * height of every item, and only the items in view (plus a few beyond)
 * mounted, absolutely positioned inside it. The engine is `useRowWindow`;
 * a consumer whose rows must own their own element, or whose window drives
 * more than a list (the sessions browser's lane paging and focus
 * transfer), drives that engine directly with its own markup.
 */
export function VirtualList<T>({
  items,
  itemKey,
  estimate,
  render,
  className,
  role,
  ariaLabel,
  onReachEnd,
  spacer,
  item,
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const window = useRowWindow({ rows: items, keyOf: itemKey, estimate, scrollRef });

  const { atEnd } = window;
  useEffect(() => {
    if (atEnd) onReachEnd?.();
  }, [atEnd, items.length, onReachEnd]);

  const Spacer = spacer?.as ?? "div";
  const Item = item?.as ?? "div";
  return (
    <div className={className} ref={scrollRef} role={role} aria-label={ariaLabel}>
      <Spacer
        className={spacer?.className}
        style={{ height: `${window.totalSize}px`, position: "relative" }}
      >
        {window.items.map((slot) => (
          <Item
            key={slot.key}
            ref={window.measure}
            data-index={slot.index}
            className={item?.className}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${slot.start}px)`,
            }}
          >
            {render(items[slot.index], slot.index)}
          </Item>
        ))}
      </Spacer>
    </div>
  );
}
