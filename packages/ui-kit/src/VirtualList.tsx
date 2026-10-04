import { useEffect, useLayoutEffect, useReducer, useRef, type ReactNode } from "react";
import { motionOf } from "./listMotion";
import { useFocusHandoff } from "./useFocusHandoff";
import { usePinnedHeading } from "./usePinnedHeading";
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
   * Return null for no heading. `height` is the room it covers — a row
   * revealed upward stops below it — and the distance the next group's
   * heading pushes it out over, so it is the heading's real height. `heads`
   * says which items start a group: the next one, reaching the top, pushes
   * the pinned heading out ahead of it (`pinnedFrame`) instead of sliding
   * under it. */
  sticky?: {
    className: string;
    height: number;
    render: (firstVisibleIndex: number) => ReactNode;
    heads: (item: T) => boolean;
  };
  /** The consumer's token for a change the person made (a fold): when it
   * changes with the items, that change may move (`useListMotion`), and
   * the item it happened after (the heading folded) holds its place — the
   * rows it opens go below it, never above the viewport. Any value
   * compared by identity; absent, the list never eases. It must change by
   * the person's act ONLY: a change written by anyone else under it would
   * be eased and held as theirs, the list scrolling to its place. */
  easeKey?: unknown;
}

/** How long a change's motion marks stand — past the longest entrance a
 * consumer runs on them, short enough that a row the scroll mounts later
 * never wears one. */
export const LIST_MOTION_WINDOW_MS = 400;

/**
 * The list's own motion, asked for by the consumer and by nothing else: a
 * change of `easeKey` (the consumer's token for "the person moved this" —
 * a fold) with the items marks that ONE change as easing — the list's box
 * wears `data-easing`, and the keys that joined the items there wear
 * `data-arriving`. Any other change of the items (a status an agent moved,
 * a measurement, the anchoring keeping the reader's place) marks nothing,
 * so it lands still. The marks stand only LIST_MOTION_WINDOW_MS after the
 * change: a later render (a scroll mounting a row) finds them gone, and
 * scrolling never replays an entrance. Nothing moves on the first paint.
 *
 * Held per CHANGE of the rows, written during render idempotently — a
 * second render of the same items (StrictMode, a hover), or a fresh array
 * of the same rows in the same order, keeps the marks.
 */
function useListMotion<T>(
  items: readonly T[],
  itemKey: (item: T) => string,
  easeKey: unknown,
): { easing: boolean; arriving: ReadonlySet<string>; held: string | null } {
  const track = useRef<{
    items: readonly T[];
    easeKey: unknown;
    arriving: ReadonlySet<string> | null;
    /** The item the person's change happened after — for THIS change of
     * the items only: a later one, theirs or not, holds nothing. */
    held: string | null;
  } | null>(null);
  if (track.current === null) {
    track.current = { items, easeKey, arriving: null, held: null };
  } else if (easeKey === undefined && track.current.easeKey === undefined) {
    // A list that never eases (no token) pays nothing per change.
    track.current.items = items;
  } else if (track.current.items !== items) {
    // What this change marks is `motionOf`'s to say; held here per change.
    const previous = track.current;
    const marks = motionOf(previous.items.map(itemKey), items.map(itemKey), previous.easeKey !== easeKey, previous);
    track.current = { items, easeKey, ...marks };
  }
  // The marks expire on a timer, not by a clock read in render: the timer
  // drops them and renders once more, so whatever renders after sees none.
  const arriving = track.current.arriving;
  const [, expired] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (arriving === null) return;
    const timer = setTimeout(() => {
      if (track.current?.arriving === arriving) {
        track.current.arriving = null;
        expired();
      }
    }, LIST_MOTION_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [arriving]);
  return { easing: arriving !== null, arriving: arriving ?? NONE, held: track.current.held };
}

const NONE: ReadonlySet<string> = new Set();


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
  easeKey,
  spacer,
  item,
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const motion = useListMotion(items, itemKey, easeKey);
  const rowWindow = useRowWindow({
    rows: items,
    keyOf: itemKey,
    estimate,
    scrollRef,
    coveredTop: sticky?.height,
    holdKey: motion.held,
  });
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

  const pinned = usePinnedHeading(
    scrollRef,
    rowWindow.items,
    sticky?.height ?? 0,
    sticky ? (index) => sticky.heads(items[index]) : null,
  );

  const Spacer = spacer?.as ?? "div";
  const Item = item?.as ?? "div";
  // The name and role go on the list itself: a `ul` spacer IS the list a
  // reader walks, and a label on the generic scroll box around it is not
  // announced.
  const named = { role, "aria-label": ariaLabel };
  const spacerIsList = Spacer === "ul";
  return (
    // Focusable by script only — the handoff's landing, never a Tab stop.
    <div
      className={className}
      ref={scrollRef}
      {...(spacerIsList ? {} : named)}
      tabIndex={-1}
      data-easing={motion.easing || undefined}
    >
      {sticky && pinned.first >= 0 && (
        // Zero tall, so it pushes nothing down; its content hangs over the
        // rows below it, pinned to the scroll box's top while they scroll.
        <div style={{ position: "sticky", top: 0, height: 0, zIndex: 1 }}>
          <div className={sticky.className} ref={pinned.layerRef}>
            {sticky.render(pinned.first)}
          </div>
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
            data-arriving={motion.arriving.has(slot.key as string) || undefined}
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
