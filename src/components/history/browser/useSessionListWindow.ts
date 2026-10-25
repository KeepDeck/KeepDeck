import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { VirtualItem } from "@tanstack/react-virtual";
import { useRowWindow } from "@keepdeck/ui-kit/useRowWindow";
import { useFocusHandoff } from "@keepdeck/ui-kit/useFocusHandoff";
import type { LaneApi } from "../../../app/useSessionsBrowser";
import { rowKeyOf, type UnifiedSessionRow } from "../../../domain/journal";

const PAGE_AHEAD = 40;

/** The first paint's guess at a row: the meta line wraps and a future
 * snippet stretches the row AFTER first paint, so the estimate overshoots
 * generously — the scrollbar must never undershoot — and measurement
 * corrects it. */
const ESTIMATED_ROW_PX = 72;

type SessionListWindowLane = Pick<LaneApi, "hits" | "hasMore" | "loadMore">;

export interface SessionListWindowInput {
  listRef: RefObject<HTMLUListElement | null>;
  queue: readonly UnifiedSessionRow[];
  workspaceRowCount: number;
  workspace: SessionListWindowLane;
  other: SessionListWindowLane;
}

export interface SessionListWindow {
  virtualItems: readonly VirtualItem[];
  totalSize: number;
  measureRow(element: HTMLLIElement | null): void;
  onListScroll(): void;
}

/**
 * The sessions browser's window over the ONE flat queue (workspace rows,
 * then other rows — the composition's order, untouched). The engine —
 * the virtualizer, the measuring, the anchor-by-key correction that
 * keeps a watched row at its offset when a page lands above it — is the
 * app's shared `useRowWindow`, and the keyboard's place when a focused
 * row unmounts is the shared `useFocusHandoff`; what is this list's own
 * is the two paging thresholds, one per lane. Keys are agent:sessionId —
 * NEVER the index.
 *
 * A note the engine keeps for every list: the React "flushSync was
 * called from inside a lifecycle method" warning on measurement and
 * correction is the library's sync rerender (useFlushSync, on by
 * default), triggered by measure() from layout effects. Deliberately
 * untouched: the sync rerender exists to kill flicker; flipping it
 * would trade a VISIBLE property for a quiet console.
 */
export function useSessionListWindow({
  listRef,
  queue,
  workspaceRowCount,
  workspace,
  other,
}: SessionListWindowInput): SessionListWindow {
  const {
    items: virtualItems,
    lastIndex: lastVirtualIndex,
    totalSize,
    measure: measureRow,
  } = useRowWindow({
    rows: queue,
    keyOf: rowKeyOf,
    estimate: ESTIMATED_ROW_PX,
    scrollRef: listRef,
  });

  // The two thresholds from the range — re-checked on range change AND
  // after each landed page (a landing shifts the ends without a scroll).
  // Two SEPARATE asks, each to its own engine; both may fire on one
  // position; the engines' own in-flight/exhausted guards make repeats
  // harmless — one ask per threshold per landing. PAGE_AHEAD = 40 rows:
  // one page's buffer is eaten by a fast fling in 0.35–0.5s while the
  // page rides hundreds of ms, so the buffer must be wider than one
  // page. (The spawn dialog's picker keeps the OLD scroll-geometry hook
  // — the browser moved to the virtual range, the picker kept the
  // former.) The thresholds count DATA rows only: the tail's spinner
  // and error line are NOT part of the queue, never in the arithmetic.
  // HONEST LIMIT: the stand's pinned sizes prove the threshold
  // ARITHMETIC (which engine, how far, how often); whether 40 rows
  // feels early enough in a live fling is the user's eye, not ours.
  // The lane objects are rebuilt with every browser render; the paging
  // decision is about the range and the counts, so read the latest lanes
  // through a ref and re-check on a range change or a landed page.
  const lanes = useRef({ workspace, other });
  lanes.current = { workspace, other };
  const checkPaging = useCallback(() => {
    const { workspace, other } = lanes.current;
    if (lastVirtualIndex < 0) return;
    // The workspace lane's tail asks ONLY its own engine.
    if (workspace.hasMore && workspaceRowCount > 0) {
      if (workspaceRowCount - 1 - lastVirtualIndex <= PAGE_AHEAD) {
        workspace.loadMore();
      }
    }
    // The list's tail asks ONLY the other engine.
    if (other.hasMore) {
      if (queue.length - 1 - lastVirtualIndex <= PAGE_AHEAD) {
        other.loadMore();
      }
    }
  }, [lastVirtualIndex, workspaceRowCount, queue.length]);
  const landedPages = workspace.hits.length + other.hits.length;
  // Both a landed page and a lane's `hasMore` are paging triggers: a scan
  // can raise a lane's total, flipping `hasMore` false→true, while the
  // cached hits and the range stay exactly as they were. Without the
  // hasMore values here the new tail waits for a scroll that may never
  // come. With both lanes empty there is nothing to page toward.
  useEffect(() => {
    if (landedPages > 0 || workspace.hasMore || other.hasMore) checkPaging();
  }, [checkPaging, landedPages, workspace.hasMore, other.hasMore]);

  // A focused row scrolled out keeps the keyboard's place on the list —
  // the app's one handoff, shared with every windowed list (ui-kit).
  useFocusHandoff(listRef);
  return {
    virtualItems,
    totalSize,
    measureRow,
    // A scroll asks only for paging: the virtualizer hears the scroll on
    // its own, and keeps the heights it measured.
    onListScroll: checkPaging,
  };
}
