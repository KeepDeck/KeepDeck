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
}

export interface RowWindow {
  /** The mounted slice: each item's index, key and start offset. */
  items: readonly VirtualItem[];
  /** The last mounted row's index; -1 while nothing is mounted. What a
   * grower checks its paging against. */
  lastIndex: number;
  /** The measured height of every row — the spacer's height. */
  totalSize: number;
  /** ONE callback for every row's ref — a fresh arrow per row would ride
   * the props and fell every row's memo on every parent render. The row
   * is resolved by its `data-index`. */
  measure(element: HTMLElement | null): void;
  /** Re-read the geometry — after a programmatic scroll. */
  remeasure(): void;
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
}: RowWindowInput<Row>): RowWindow {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (typeof estimate === "number" ? estimate : estimate(rows[index])),
    overscan,
    getItemKey: useCallback((index: number) => keyOf(rows[index]), [rows, keyOf]),
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
  });
  const measure = useCallback(
    (element: HTMLElement | null) => virtualizer.measureElement(element),
    // The virtualizer instance is stable for the mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  return {
    items,
    lastIndex,
    totalSize: virtualizer.getTotalSize(),
    measure,
    remeasure: () => virtualizer.measure(),
  };
}
