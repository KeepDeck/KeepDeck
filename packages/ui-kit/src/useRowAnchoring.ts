import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type {
  ReactVirtualizer,
  VirtualItem,
} from "@tanstack/react-virtual";
import { pickAnchor, type AnchorState } from "./rowAnchor";

interface UseRowAnchoringInput<Row> {
  /** The SCROLL container — a list element in one caller, the panel
   * around it in another. Only its scroll offset is read. */
  listRef: RefObject<HTMLElement | null>;
  /** The full list, stable by identity between renders — the effect
   * below acts on a CHANGE of this array and on nothing else. */
  queue: readonly Row[];
  /** A row's identity. Stable, and never an index: the whole point is
   * to survive a list whose composition moved. */
  keyOf: (row: Row) => string;
  virtualItems: readonly VirtualItem[];
  lastVirtualIndex: number;
  rowVirtualizer: Pick<
    ReactVirtualizer<HTMLElement, HTMLElement>,
    "measurementsCache" | "getTotalSize"
  >;
  /** The row a change of THIS queue was the person's own act at (the
   * heading of a group they folded), or null. Held instead of the first
   * row in view: the rows the act opens go below it, and a row scrolled
   * up under the top edge comes down to it — never an act whose result
   * lands above the viewport, out of sight. */
  holdKey?: string | null;
}

/** Keep the first visible row at its viewport offset when the list grows
 * above it. The anchor is keyed by row identity, not by a virtual index
 * that an insertion can shift.
 *
 * Shared by every windowed list in the app: what moves rows in above the
 * one being read differs per list — a landed page here, an agent's
 * publish there — but the correction does not, and a second copy of it
 * would be a second place for the two-effects rule below to be got
 * wrong.
 *
 * What this does NOT own: a row that keeps its key and changes HEIGHT (a
 * title edited to wrap a second line). No queue change, so nothing here
 * runs — the virtualizer's own re-measure answers it when the
 * ResizeObserver reports, after the layout phase: a row ENTIRELY above
 * the fold shifts the scroll by its growth (tanstack's default
 * shouldAdjustScrollPositionOnItemSizeChange), so the row being read
 * stays; a row spanning the fold grows below the reading line, and what
 * is under it moves down — honestly, the content grew there. */
/**
 * CONTRACT: the scroll element is mounted with the hook and stays the
 * same element for the hook's life — its scroll listener is attached once,
 * at mount. A consumer that renders its scroll box only after loading
 * (an early `return` before the list) would leave the listener unattached
 * and the anchor stale: mount the box, and put the loading state inside.
 */
export function useRowAnchoring<Row>({
  listRef,
  queue,
  keyOf,
  virtualItems,
  lastVirtualIndex,
  rowVirtualizer,
  holdKey = null,
}: UseRowAnchoringInput<Row>): void {
  // The insertion-above correction — TWO SEPARATE EFFECTS, never one:
  // ARMING remembers the first fully visible row and its offset (it
  // runs on RANGE changes — ordinary scrolling re-arms, that is the
  // point); COMPENSATION shifts the scroll and runs ONLY on QUEUE
  // changes (a landed page). The merged version armed rarely but
  // compensated on every range change — an ordinary scroll to row 50
  // found the stale anchor at index 0 and flung the list back to the
  // top: the regression the review caught live.
  // The lookup runs over the FULL QUEUE, never the window: the target
  // case is a watched other-row near the viewport's top, twenty
  // workspace rows landing ABOVE it — after the insertion it sits
  // ~twenty heights further down and OUTSIDE the new window. A
  // window-only lookup would misread the SAME key as vanished and
  // hand the anchor to an inserted row — the very jump this exists to
  // prevent. The position comes from the library's measured cache
  // (`startOf`) — every row, window or no window; our own
  // queue array supplies the key's index. The vanished/not-yet-
  // measured branch holds the offset and re-arms.
  const anchorRef = useRef<AnchorState | null>(null);
  // Where the anchor's key stood in the queue when last found — checked
  // first, so the lookup on every scroll event is one comparison, and a
  // scan only when the queue really moved (a files tree runs to tens of
  // thousands of rows, at sixty-plus scroll events a second).
  const anchorIndex = useRef(-1);
  const indexOfAnchor = (rows: readonly Row[], keyOfRow: (row: Row) => string, key: string) => {
    const hint = anchorIndex.current;
    const index =
      hint >= 0 && hint < rows.length && keyOfRow(rows[hint]) === key
        ? hint
        : rows.findIndex((row) => keyOfRow(row) === key);
    anchorIndex.current = index;
    return index;
  };
  // A row's MEASURED start — never the library's getOffsetForIndex, which
  // is the scroll offset that would ALIGN the row, clamped to the furthest
  // the list can scroll: for a row starting past that (any first visible
  // row within a row of the end) it is not the row's start, and an anchor
  // held from it pushed the scroll forward when a page landed below.
  // getTotalSize first: it rebuilds the positions from every height
  // measured so far — rows that mounted in this very commit included.
  const startOf = (index: number): number | null => {
    rowVirtualizer.getTotalSize();
    return rowVirtualizer.measurementsCache[index]?.start ?? null;
  };
  const windowRowsOf = () =>
    virtualItems.map((v) => ({ key: v.key as string, start: v.start }));
  // The full re-pick: the first fully visible row of this render's window.
  const armFirstVisible = (list: HTMLElement) => {
    const first = pickAnchor(windowRowsOf(), list.scrollTop);
    anchorRef.current = first
      ? { key: first.key, offset: first.start - list.scrollTop }
      : null;
  };
  // COMPENSATION FIRST, arming second — declaration order is the run
  // order of layout effects: when a landed page changes BOTH the
  // queue and the range in one commit, compensation must read the
  // PREVIOUS scroll's anchor before arming overwrites it with the
  // new window's first row.
  //
  // COMPENSATION — on queue changes ONLY: if rows landed above the
  // armed anchor, shift the scroll so the anchor key keeps its
  // offset. useLayoutEffect: the shift must land in the layout phase,
  // before the browser paints — a passive effect would flash the
  // un-shifted position first.
  const queueRef = useRef(queue);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const prevQueue = queueRef.current;
    queueRef.current = queue;
    if (prevQueue === queue) return; // not a queue change — never act
    const scrollTop = list.scrollTop;
    // The person's own act holds the row it happened at: where it stands
    // when in view or below, at the top edge when it was scrolled up past
    // it. Rows above it did not move, so its start is the same as before.
    const held = holdKey === null ? -1 : indexOfAnchor(queue, keyOf, holdKey);
    const heldStart = held >= 0 ? startOf(held) : null;
    if (holdKey !== null && heldStart !== null) {
      const target = Math.min(scrollTop, heldStart);
      anchorRef.current = { key: holdKey, offset: heldStart - target };
      if (target !== scrollTop) {
        list.scrollTop = target;
        list.dispatchEvent(new Event("scroll"));
      }
      return;
    }
    const prev = anchorRef.current;
    if (prev === null) return;
    const nextIndex = indexOfAnchor(queue, keyOf, prev.key);
    if (nextIndex >= 0) {
      // Positions as measured NOW (see `startOf`): the rows that just
      // mounted above have reported their heights in this very commit;
      // placed by the estimate they were painted with, the anchor would be
      // off by the difference per row.
      const start = startOf(nextIndex);
      if (start !== null) {
        const target = start - prev.offset;
        if (target !== scrollTop) {
          list.scrollTop = target;
          // A programmatic scrollTop assignment fires a scroll event
          // in a real browser — dispatch it ourselves so the
          // virtualizer learns the new offset the way it would have.
          // That is all the virtualizer needs. Never `measure()` here:
          // it CLEARS every measured height, the mounted rows report
          // none again (an observer speaks on a resize, a ref on a
          // mount), and each stays at the estimate — a gap under it.
          // The event also re-reads the anchor's offset through the
          // listener below — from the scroll as the browser set it, which
          // differs from the target when the browser clamped it.
          list.dispatchEvent(new Event("scroll"));
        }
        return; // the anchor held — key found, offset kept
      }
    }
    // Vanished: hold the offset, and re-arm NOW on what is first
    // visible. Waiting for the next range change left a dead key armed
    // when the removal moved neither the scroll nor the window's end —
    // and the next landing above found nothing to hold. A key still in
    // the queue but not yet measurable keeps its anchor (rowAnchor.ts).
    if (nextIndex < 0) armFirstVisible(list);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue]);
  // ARMING — on SCROLL POSITION, not the range's last index: a small
  // scroll may change the first fully visible row while the last
  // index stands (the seam peer-4 found) — arming keyed on the index
  // would keep a STALE anchor through exactly the movements that
  // matter. CONTINUITY RULE: if the armed anchor's row is still in
  // the window, arming follows THAT row to its new position (updates
  // its offset) instead of re-picking the first visible — a
  // re-pick right after a compensation shift would latch a neighbor
  // and drift. A full re-pick happens only when the anchor left the
  // window (real scroll) or none is armed.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const prev = anchorRef.current;
    if (prev !== null) {
      const still = windowRowsOf().find((r) => r.key === prev.key);
      if (still) {
        anchorRef.current = { key: prev.key, offset: still.start - list.scrollTop };
        return;
      }
    }
    armFirstVisible(list);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listRef.current?.scrollTop, lastVirtualIndex]);
  // THE ANCHOR'S OFFSET, kept true on EVERY scroll — arming runs only on
  // re-renders, and a scroll within the window renders nothing, so between
  // armings the offset went stale by however far the person had scrolled.
  // The compensation sets the scroll to "anchor row minus offset": with a
  // stale offset, every new array (git's changes rebuilt per render, a
  // board tick, a watch event) wrote the scroll BACK to where it stood at
  // the last arming — the list scrolled back by itself mid-scroll, and on
  // a trackpad the write killed the momentum into a bounce. Updated here,
  // the offset is the person's own: unchanged rows then resolve to the
  // scroll as it is, and nothing is written. The library's own size
  // corrections move the row and the scroll together, so the offset holds
  // through them; only the person's scroll changes it, and that is
  // exactly what this hears.
  // The listener reads the queue the compensation last acted on
  // (`queueRef`, written in its layout effect) and the key function of the
  // last commit — refs written in effects, never during render.
  const keyOfRef = useRef(keyOf);
  useLayoutEffect(() => {
    keyOfRef.current = keyOf;
  });
  useEffect(() => {
    const list = listRef.current;
    if (!list) {
      // The CONTRACT above, broken loudly: unheard, the anchor goes stale.
      console.warn("useRowAnchoring: no scroll element at mount — the anchor will not follow scrolling");
      return;
    }
    const onScroll = () => {
      const anchor = anchorRef.current;
      if (anchor === null) return;
      const index = indexOfAnchor(queueRef.current, keyOfRef.current, anchor.key);
      if (index < 0) return;
      const start = startOf(index);
      if (start !== null) anchorRef.current = { key: anchor.key, offset: start - list.scrollTop };
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => list.removeEventListener("scroll", onScroll);
    // The list element and the virtualizer are stable for the mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
