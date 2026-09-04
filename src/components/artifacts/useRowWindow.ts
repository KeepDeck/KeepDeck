import { useCallback, type RefObject } from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { useRowAnchoring } from "../../ui/useRowAnchoring";
import type { ArtifactMetaRow } from "../../ipc/artifacts";

/** Rows drawn beyond the visible edge, so a scroll never shows a gap. */
const OVERSCAN_ROWS = 6;

/** A row with nothing open under it; the first paint's guess, corrected
 * by measurement the moment a row reports its real box. */
const ESTIMATED_ROW_PX = 56;

export interface RowWindow {
  items: readonly VirtualItem[];
  totalSize: number;
  measure(element: HTMLLIElement | null): void;
}

/**
 * The artifacts list's window.
 *
 * A workspace's artifacts have no ceiling — an agent publishes as many
 * as the work needs, and nothing prunes them — so the list is windowed
 * like the sessions browser's, for the same reason and with the same
 * library. Drawing all of them was fine at the tens they run to today
 * and is not a property anything guarantees.
 *
 * Measured, not assumed: an item is a row plus, when it is the open one,
 * its whole version history — so heights differ by an order of
 * magnitude within one list, and an estimate alone would put the
 * scrollbar and the rows in different places.
 */
export function useRowWindow(
  rows: readonly ArtifactMetaRow[],
  scrollRef: RefObject<HTMLElement | null>,
): RowWindow {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    overscan: OVERSCAN_ROWS,
    // The artifact's id, never the index: a publish reorders the list
    // (newest first), and an index key would hand one row's measured
    // height — an open history's, at its tallest — to whatever slid
    // into its place.
    getItemKey: useCallback((index: number) => rows[index].id, [rows]),
  });

  const items = virtualizer.getVirtualItems();
  // Rows arrive ABOVE the one being read — an agent publishes and the
  // list is newest-first — and a window that only re-measures leaves the
  // scroll where it was, sliding the read row down by a row's height per
  // publish, often out of sight. The correction is the sessions
  // browser's, shared rather than rewritten: what inserts differs per
  // list, what to do about it does not.
  useRowAnchoring({
    listRef: scrollRef,
    queue: rows,
    keyOf: (row) => row.id,
    virtualItems: items,
    lastVirtualIndex: items.length > 0 ? items[items.length - 1].index : 0,
    rowVirtualizer: virtualizer,
  });

  return {
    items,
    totalSize: virtualizer.getTotalSize(),
    measure: virtualizer.measureElement,
  };
}
