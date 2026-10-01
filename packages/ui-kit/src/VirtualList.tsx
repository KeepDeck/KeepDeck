import { useEffect, useRef, type ReactNode } from "react";
import { useFocusHandoff } from "./useFocusHandoff";
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
  /** The item kept in view — a keyboard cursor: each time it CHANGES,
   * the list scrolls just enough to show it. Only on a change: re-showing
   * it on every render would pull the list back from wherever the person
   * scrolled to. */
  revealKey?: string | null;
}

/**
 * The windowed list as a component: the scroll container, a spacer the
 * height of every item, and only the items in view (plus a few beyond)
 * mounted, absolutely positioned inside it. The engine is `useRowWindow`;
 * the keyboard's place is kept by `useFocusHandoff` when a focused row
 * scrolls out. A consumer whose rows must own their own element, or whose
 * window drives more than a list (the sessions browser's lane paging),
 * drives those directly with its own markup.
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
  revealKey = null,
  spacer,
  item,
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const window = useRowWindow({ rows: items, keyOf: itemKey, estimate, scrollRef });
  // A focused row scrolled out keeps the keyboard's place on the list.
  useFocusHandoff(scrollRef);

  const { atEnd } = window;
  useEffect(() => {
    if (atEnd) onReachEnd?.();
  }, [atEnd, items.length, onReachEnd]);

  const { reveal } = window;
  useEffect(() => {
    if (revealKey === null) return;
    const index = items.findIndex((it) => itemKey(it) === revealKey);
    // A key not (yet) among the items is not revealed later: the key must
    // name an item of the same render that sets it.
    if (index >= 0) reveal(index);
    // A change of the key, never of the items: see `revealKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey]);

  const Spacer = spacer?.as ?? "div";
  const Item = item?.as ?? "div";
  return (
    // Focusable by script only — the handoff's landing, never a Tab stop.
    <div className={className} ref={scrollRef} role={role} aria-label={ariaLabel} tabIndex={-1}>
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
