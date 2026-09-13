import { useLayoutEffect, useRef } from "react";
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
    "getOffsetForIndex" | "measure"
  >;
}

/** Keep the first visible row at its viewport offset when the list grows
 * above it. The anchor is keyed by row identity, not by a virtual index
 * that an insertion can shift.
 *
 * Shared by every windowed list in the app: what moves rows in above the
 * one being read differs per list — a landed page here, an agent's
 * publish there — but the correction does not, and a second copy of it
 * would be a second place for the two-effects rule below to be got
 * wrong. */
export function useRowAnchoring<Row>({
  listRef,
  queue,
  keyOf,
  virtualItems,
  lastVirtualIndex,
  rowVirtualizer,
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
  // prevent. The position comes from the library's getOffsetForIndex
  // — it reads the full measured cache, window or no window; our own
  // queue array supplies the key's index. The vanished/not-yet-
  // measured branch holds the offset and re-arms.
  const anchorRef = useRef<AnchorState | null>(null);
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
    const prev = anchorRef.current;
    if (prev === null) return;
    const scrollTop = list.scrollTop;
    const nextIndex = queue.findIndex((r) => keyOf(r) === prev.key);
    if (nextIndex >= 0) {
      const at = rowVirtualizer.getOffsetForIndex(nextIndex, "start");
      if (at) {
        const target = at[0] - prev.offset;
        if (target !== scrollTop) {
          list.scrollTop = target;
          // A programmatic scrollTop assignment fires a scroll event
          // in a real browser — dispatch it ourselves so the
          // virtualizer learns the new offset the way it would have.
          list.dispatchEvent(new Event("scroll"));
          rowVirtualizer.measure();
          // Re-arm at the corrected position: the same key, same
          // offset — the next range change re-arms naturally.
          anchorRef.current = { key: prev.key, offset: prev.offset };
        }
        return; // the anchor held — key found, offset kept
      }
    }
    // Vanished (or not yet measurable): hold the offset; the ARMING
    // effect re-arms on the next range change.
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
    const windowRows = virtualItems.map((v) => ({
      key: v.key as string,
      start: v.start,
    }));
    const prev = anchorRef.current;
    if (prev !== null) {
      const still = windowRows.find((r) => r.key === prev.key);
      if (still) {
        anchorRef.current = { key: prev.key, offset: still.start - list.scrollTop };
        return;
      }
    }
    const first = pickAnchor(windowRows, list.scrollTop);
    anchorRef.current = first
      ? { key: first.key, offset: first.start - list.scrollTop }
      : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listRef.current?.scrollTop, lastVirtualIndex]);
}
