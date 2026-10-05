import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { marksOf, type ChangeMarks } from "./listMotion";
import { useFoldMotion } from "./useFoldMotion";
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
  /** The list's id, where its role and name go — what a field that drives
   * it (a combobox's `aria-controls`) points at. */
  id?: string;
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
   * changes with the items, that change is played out as a fold
   * (`useFoldMotion`), and the item it happened after (the heading folded)
   * holds its place — the rows it opens go below it, never above the
   * viewport. Any value
   * compared by identity; absent, the list never eases. It must change by
   * the person's act ONLY: a change written by anyone else under it would
   * be eased and held as theirs, the list scrolling to its place. */
  easeKey?: unknown;
}

/**
 * What the latest change of the rows is (`marksOf`): the person's — a
 * change of `easeKey` with the items, which moves and holds the item it
 * happened after — or anyone else's, which lands still. Held per CHANGE of
 * the rows, written during render idempotently: a second render of the
 * same items keeps the marks; a fresh array of the same rows is a change
 * of nobody's, and holds nothing.
 */
function useChangeMarks<T>(items: readonly T[], itemKey: (item: T) => string, easeKey: unknown): ChangeMarks {
  const track = useRef<{ items: readonly T[]; easeKey: unknown; marks: ChangeMarks } | null>(null);
  if (track.current === null) {
    track.current = { items, easeKey, marks: STILL };
  } else if (easeKey === undefined && track.current.easeKey === undefined) {
    // A list that never eases (no token) pays nothing per change.
    track.current.items = items;
  } else if (track.current.items !== items) {
    const previous = track.current;
    track.current = {
      items,
      easeKey,
      marks: marksOf(previous.items.map(itemKey), items.map(itemKey), previous.easeKey !== easeKey),
    };
  }
  return track.current.marks;
}

const STILL: ChangeMarks = { eased: false, held: null };

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
  id,
  onReachEnd,
  revealKey = null,
  sticky,
  easeKey,
  spacer,
  item,
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const marks = useChangeMarks(items, itemKey, easeKey);
  // The fold's hand-offs reach it through a ref: the anchoring is set up
  // before the fold, which needs the layout the window lays out.
  const foldRef = useRef<ReturnType<typeof useFoldMotion<T>> | null>(null);
  const rowWindow = useRowWindow({
    rows: items,
    keyOf: itemKey,
    estimate,
    scrollRef,
    coveredTop: sticky?.height,
    holdKey: marks.held,
    holdWalk: (from, to) => foldRef.current?.takeWalk(from, to) ?? false,
    onShift: (by) => foldRef.current?.shifted(by),
  });
  const fold = useFoldMotion<T>({
    items,
    eased: marks.eased,
    readLayout: rowWindow.readLayout,
    folds: easeKey !== undefined,
    scrollRef,
    overscan: FOLD_OVERSCAN_PX,
  });
  foldRef.current = fold;
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
    // name an item of the same render that sets it. A fold in flight lands
    // first: the reveal reads the final layout, and so must the scroll.
    if (index >= 0) {
      fold.settle();
      reveal(index);
    }
    // A change of the key, never of the items: see `revealKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey]);

  const frame = fold.frame;
  const pinned = usePinnedHeading(
    scrollRef,
    // During a fold the pinned heading reads what is DRAWN, ghosts and all.
    frame ? frame.occupancy : rowWindow.items,
    sticky?.height ?? 0,
    sticky ? (index) => sticky.heads(items[index]) : null,
  );

  const Spacer = spacer?.as ?? "div";
  const Item = item?.as ?? "div";
  // The name and role go on the list itself: a `ul` spacer IS the list a
  // reader walks, and a label on the generic scroll box around it is not
  // announced.
  const named = { role, "aria-label": ariaLabel, id };
  const spacerIsList = Spacer === "ul";
  return (
    // Focusable by script only — the handoff's landing, never a Tab stop.
    <div
      className={className}
      ref={scrollRef}
      {...(spacerIsList ? {} : named)}
      tabIndex={-1}
      // The list keeps the reader's place itself (`useRowAnchoring`), and a
      // fold paints the spacer over time: the browser's own scroll anchoring
      // would answer both a second time.
      style={{ overflowAnchor: "none" }}
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
        style={{
          height: `${frame ? Math.max(frame.total, (scrollRef.current?.scrollTop ?? 0) + (scrollRef.current?.clientHeight ?? 0)) : rowWindow.totalSize}px`,
          position: "relative",
        }}
        {...(spacerIsList ? named : {})}
      >
        {frame ? (
          <>
            {frame.rows
              .filter((row) => row.box === null)
              .map((row) => (
                <Item key={row.key} ref={rowWindow.measure} data-index={row.index} className={item?.className} style={placed(row.top)}>
                  {render(items[row.index], row.index)}
                </Item>
              ))}
            {frame.boxes.map((box) => (
              // One clipping box per place the rows changed: the group
              // unrolls from under its heading, or rolls up into it.
              <div key={`fold:${box.segment}`} style={{ position: "absolute", top: box.top, left: 0, width: "100%", height: box.height, overflow: "hidden" }}>
                {frame.rows
                  .filter((row) => row.box === box.segment)
                  .map((row) => (
                    <Item key={row.key} ref={rowWindow.measure} data-index={row.index} className={item?.className} style={placed(row.top)}>
                      {render(items[row.index], row.index)}
                    </Item>
                  ))}
                {frame.ghosts
                  .filter((ghost) => ghost.segment === box.segment)
                  .map((ghost) => {
                    const left = fold.ghost(ghost.key);
                    // A row that left, drawn as it was until the fold ends:
                    // measured by nobody, reached by nothing.
                    return left === undefined ? null : (
                      <Item key={`ghost:${ghost.key}`} className={item?.className} style={{ ...placed(ghost.top), pointerEvents: "none" }} inert aria-hidden>
                        {render(left, -1)}
                      </Item>
                    );
                  })}
              </div>
            ))}
          </>
        ) : (
          rowWindow.items.map((slot) => (
            <Item key={slot.key} ref={rowWindow.measure} data-index={slot.index} className={item?.className} style={placed(slot.start)}>
              {render(items[slot.index], slot.index)}
            </Item>
          ))
        )}
      </Spacer>
    </div>
  );
}

/** How far past the view a fold mounts what it draws — the window's
 * overscan, in pixels. */
const FOLD_OVERSCAN_PX = 200;

/** An item's box, at `top` within what holds it. */
function placed(top: number) {
  return { position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${top}px)` } as const;
}
