import { useCallback, type RefObject } from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { useRowAnchoring } from "./useRowAnchoring";

/** Rows drawn beyond the visible edge, so a scroll never shows a gap. */
export const OVERSCAN_ROWS = 6;

export interface RowWindowInput<Row> {
  /** The full list, stable by identity between renders — the anchoring
   * acts on a CHANGE of this array. */
  rows: readonly Row[];
  /** A row's identity — stable across renders, and never the index: a
   * list that reorders would hand one row's measured height to whatever
   * slid into its place. Pass a module-level or memoized function; a
   * fresh arrow per render re-keys the virtualizer's measurements. */
  keyOf: (row: Row) => string;
  /** The first paint's guess at a row's height, in pixels — one number,
   * or one per row when kinds differ; corrected by measurement the
   * moment a row reports its real box. */
  estimate: number | ((row: Row) => number);
  /** The scroll container: the list itself, or the panel around it. */
  scrollRef: RefObject<HTMLElement | null>;
  overscan?: number;
  /** Room at the top a layer covers (a pinned heading): a row revealed
   * upward stops below it, not under it. */
  coveredTop?: number;
  /** The row the person's own change of `rows` happened at, held in place
   * (`useRowAnchoring`'s `holdKey`). */
  holdKey?: string | null;
  /** Passed to the anchoring (`useRowAnchoring`): a fold that walks the
   * hold's scroll, and hears of every compensation. */
  holdWalk?: (from: number, to: number) => boolean;
  onShift?: (by: number) => void;
}

export interface RowWindow {
  /** The mounted slice: each item's index, key and start offset. */
  items: readonly VirtualItem[];
  /** The last mounted row's index; -1 while nothing is mounted. What a
   * grower checks its paging against. */
  lastIndex: number;
  /** The last row is in the window — "in the window", not "scrolled to":
   * a list shorter than its viewport has its end in view from the first
   * paint, and a grower must hear that too. False for an empty list. */
  atEnd: boolean;
  /** The measured height of every row — the spacer's height. */
  totalSize: number;
  /** Every row as laid out now — key, start, end, in index order: the
   * final layout a fold is painted toward. A COPY: the virtualizer keeps
   * its layout in one buffer it rewrites in place, so a layout kept from
   * an earlier render must not be a view of it. */
  readLayout(): { rows: { key: string; start: number; end: number }[]; total: number };
  /** While a fold paints the list, a row measured for the first time must
   * not move the scroll: the virtualizer corrects it as if the row stood
   * at its FINAL place above the view, while the fold draws it elsewhere —
   * and the correction cancels the person's wheel in flight (reviewer-3,
   * task-249). On: no correction; off: the virtualizer's own rule. */
  holdSizeCorrections(on: boolean): void;
  /** ONE callback for every row's ref — a fresh arrow per row would ride
   * the props and fell every row's memo on every parent render. The row
   * is resolved by its `data-index`. */
  measure(element: HTMLElement | null): void;
  /** Scroll just enough to show row `index` — nothing when it is in view
   * already. Mounted or not: the window owns the offsets. */
  reveal(index: number): void;
}

/**
 * A windowed list's engine — the ONE place the app virtualizes: the
 * sessions browser, the artifacts list and a plugin's long lists share
 * it, so the library, the measuring and the anchoring exist once.
 *
 * Measured, not assumed: `estimate` places the first paint and the
 * scrollbar; each mounted row reports its real box, and the offsets
 * settle. The first fully visible row is anchored by KEY, so rows landing
 * above it (a page, a publish, a status tick) do not slide it away —
 * `useRowAnchoring`. A row scrolled out of the window is UNMOUNTED;
 * what a consumer does about focus inside it is the consumer's policy.
 */
export function useRowWindow<Row>({
  rows,
  keyOf,
  estimate,
  scrollRef,
  overscan = OVERSCAN_ROWS,
  coveredTop = 0,
  holdKey = null,
  holdWalk,
  onShift,
}: RowWindowInput<Row>): RowWindow {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (typeof estimate === "number" ? estimate : estimate(rows[index])),
    overscan,
    getItemKey: useCallback((index: number) => keyOf(rows[index]), [rows, keyOf]),
    scrollPaddingStart: coveredTop,
  });
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length > 0 ? items[items.length - 1].index : -1;
  useRowAnchoring({
    listRef: scrollRef,
    queue: rows,
    keyOf,
    virtualItems: items,
    lastVirtualIndex: lastIndex,
    rowVirtualizer: virtualizer,
    holdKey,
    holdWalk,
    onShift,
  });
  const measure = useCallback(
    (element: HTMLElement | null) => virtualizer.measureElement(element),
    // The virtualizer instance is stable for the mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const reveal = useCallback(
    (index: number) => virtualizer.scrollToIndex(index, { align: "auto" }),
    // The virtualizer instance is stable for the mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  return {
    items,
    lastIndex,
    atEnd: rows.length > 0 && lastIndex === rows.length - 1,
    totalSize: virtualizer.getTotalSize(),
    holdSizeCorrections: (on: boolean) => {
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange = on ? () => false : undefined;
    },
    readLayout: () => {
      const cache = virtualizer.measurementsCache;
      const laid: { key: string; start: number; end: number }[] = [];
      for (let index = 0; index < rows.length; index++) {
        const item = cache[index];
        // Keys are the consumer's strings (`keyOf`).
        if (item) laid.push({ key: item.key as string, start: item.start, end: item.end });
      }
      return { rows: laid, total: virtualizer.getTotalSize() };
    },
    measure,
    reveal,
  };
}
