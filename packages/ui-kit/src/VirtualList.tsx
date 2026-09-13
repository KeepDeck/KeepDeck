import { useEffect, useRef, type ReactNode } from "react";
import { useRowWindow } from "./useRowWindow";

export interface VirtualListProps<T> {
  items: readonly T[];
  /** A stable identity per item — never the index (see `useRowWindow`). */
  itemKey: (item: T) => string;
  /** The first paint's guess at an item's height, in pixels; corrected
   * by measurement the moment the row reports its real box. */
  estimate: number | ((item: T) => number);
  /** The item's content. The list positions and measures the slot
   * around it, so the content takes no position of its own. */
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
 * The windowed list as a component, for a consumer whose rows are plain
 * content: the scroll container, a spacer the height of every item, and
 * only the items in view (plus a few beyond) mounted, absolutely
 * positioned inside it. The engine is `useRowWindow`, the same one the
 * host's lists drive with their own markup.
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
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const window = useRowWindow({ rows: items, keyOf: itemKey, estimate, scrollRef });

  // The end is "in the window", not "scrolled to": a list shorter than
  // its viewport has its end in view from the first paint, and a grower
  // must hear that too.
  const reachedEnd = items.length > 0 && window.lastIndex === items.length - 1;
  useEffect(() => {
    if (reachedEnd) onReachEnd?.();
  }, [reachedEnd, items.length, onReachEnd]);

  return (
    <div className={className} ref={scrollRef} role={role} aria-label={ariaLabel}>
      <div style={{ height: `${window.totalSize}px`, position: "relative" }}>
        {window.items.map((slot) => (
          <div
            key={slot.key}
            ref={window.measure}
            data-index={slot.index}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${slot.start}px)`,
            }}
          >
            {render(items[slot.index], slot.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
