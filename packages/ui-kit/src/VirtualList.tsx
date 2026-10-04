import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
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
  /** The list's role and accessible name — on the `ul` spacer when the
   * spacer is one, else on the scroll box. */
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
  /** A heading pinned over the list's top edge, drawn from the first row
   * in view — a grouped list's "which group am I in". Items are placed
   * absolutely, so CSS `position: sticky` cannot reach one of them; this
   * is the one sticky layer, over every item, taking no room of its own.
   * Return null for no heading. `height` is the room it covers: a row
   * revealed upward stops below it. */
  sticky?: { className: string; height: number; render: (firstVisibleIndex: number) => ReactNode };
}

/**
 * The keys that joined the list at its last change — new to `items`, not
 * merely scrolled into the window (a group unfolded, a task created). A
 * consumer may animate them in (`[data-arriving]`); a row the scroll
 * mounts is not arriving, so scrolling never replays an entrance. Nothing
 * arrives on the first paint: the list was not anywhere before it.
 *
 * Held per CHANGE of the items, not per render: a render in between (a
 * hover) keeps the set, so an entrance runs to its end. Written during
 * render, idempotently — a second render of the same items (StrictMode)
 * finds them already recorded and keeps the same set.
 */
function useArriving<T>(items: readonly T[], itemKey: (item: T) => string): ReadonlySet<string> {
  const track = useRef<{ items: readonly T[]; arriving: ReadonlySet<string> } | null>(null);
  if (track.current === null) {
    track.current = { items, arriving: new Set() };
  } else if (track.current.items !== items) {
    const before = new Set(track.current.items.map(itemKey));
    track.current = { items, arriving: new Set(items.map(itemKey).filter((key) => !before.has(key))) };
  }
  return track.current.arriving;
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
  sticky,
  spacer,
  item,
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const arriving = useArriving(items, itemKey);
  const rowWindow = useRowWindow({ rows: items, keyOf: itemKey, estimate, scrollRef, coveredTop: sticky?.height });
  // A focused row scrolled out keeps the keyboard's place on the list.
  useFocusHandoff(scrollRef);

  const { atEnd, reveal } = rowWindow;
  useEffect(() => {
    if (atEnd) onReachEnd?.();
  }, [atEnd, items.length, onReachEnd]);

  // In the layout phase: the frame painted is already scrolled — a passive
  // effect paints one frame with the cursor out of view first, a stutter
  // on every held arrow key.
  useLayoutEffect(() => {
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
  // The name and role go on the list itself: a `ul` spacer IS the list a
  // reader walks, and a label on the generic scroll box around it is not
  // announced.
  const named = { role, "aria-label": ariaLabel };
  const spacerIsList = Spacer === "ul";
  return (
    // Focusable by script only — the handoff's landing, never a Tab stop.
    <div className={className} ref={scrollRef} {...(spacerIsList ? {} : named)} tabIndex={-1}>
      {sticky && rowWindow.firstVisibleIndex >= 0 && (
        // Zero tall, so it pushes nothing down; its content hangs over the
        // rows below it, pinned to the scroll box's top while they scroll.
        <div style={{ position: "sticky", top: 0, height: 0, zIndex: 1 }}>
          <div className={sticky.className}>{sticky.render(rowWindow.firstVisibleIndex)}</div>
        </div>
      )}
      <Spacer
        className={spacer?.className}
        style={{ height: `${rowWindow.totalSize}px`, position: "relative" }}
        {...(spacerIsList ? named : {})}
      >
        {rowWindow.items.map((slot) => (
          <Item
            key={slot.key}
            ref={rowWindow.measure}
            data-index={slot.index}
            data-arriving={arriving.has(slot.key as string) || undefined}
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
