import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import {
  useVirtualizer,
  type VirtualItem,
} from "@tanstack/react-virtual";
import type { LaneApi } from "../../../app/useSessionsBrowser";
import { rowKeyOf, type UnifiedSessionRow } from "../../../domain/journal";
import { useRowAnchoring } from "./useRowAnchoring";

const OVERSCAN_ROWS = 6;
const PAGE_AHEAD = 40;

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
  lastVirtualIndex: number;
  totalSize: number;
  measureRow(element: HTMLLIElement | null): void;
  onListScroll(): void;
  checkPaging(): void;
}

export function useSessionListWindow({
  listRef,
  queue,
  workspaceRowCount,
  workspace,
  other,
}: SessionListWindowInput): SessionListWindow {
  // The virtualizer over the ONE flat queue (workspace rows, then other
  // rows — the composition's order, untouched). Dynamic measurement:
  // rows carry meta lines that wrap, so heights vary; estimate runs
  // before the first measure with a generous overshoot so the scrollbar
  // never undershoots. Keys are agent:sessionId — NEVER the index.
  const rowVirtualizer = useVirtualizer({
    count: queue.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 72,
    overscan: OVERSCAN_ROWS,
    // NAMED, NOT FIXED — the React "flushSync was called from inside a
    // lifecycle method" warning on virtualization/focus/anchor
    // scenarios: the MECHANISM is the library's (its adapter's
    // onChange rerender, useFlushSync=true by default), the TRIGGER is
    // ours (measure() from the layout effects below). The switch
    // exists (useFlushSync: false) and is DELIBERATELY untouched: the
    // sync rerender exists to kill flicker on measurement and
    // correction — flipping it would trade a VISIBLE property for a
    // quiet console. The warning stays NAMED, not silenced; its cost
    // is a devtools log line, not anything user-facing. If it ever
    // truly matters, the change must come WITH a flicker measurement,
    // not blind.
    // STABLE from the stable queue: the library's measurements memo
    // keys on this callback's REFERENCE — a fresh inline arrow per
    // render (the minute tick included) dropped the memo and walked
    // the WHOLE queue's measurements on a clock tick that should touch
    // only the visible rows.
    getItemKey: useCallback(
      (index: number) => rowKeyOf(queue[index]),
      [queue],
    ),
    /**
     * ANCHOR BY KEY, not by index — the correction peer-4 named before
     * any code: a landed WORKSPACE page inserts rows ABOVE a watched
     * other-row; the watched row's INDEX shifts by the page size while
     * its KEY is the same. Anchoring by the old index would hold a
     * DIFFERENT row and produce exactly the jump this step treats.
     * The library corrects for SIZE changes above the anchor by
     * itself; INSERTIONS above are OUR half: on each queue change, if
     * rows were inserted above the first visible row (its key found at
     * a NEW index), the scroll shifts by the inserted rows' measured
     * span so the ANCHOR KEY keeps its viewport offset.
     *
     * VANISHED KEY — the explicit branch (named, not defaulted): when
     * the anchor's key leaves the queue (a real composition change —
     * search, scope change, invalidation), we HOLD THE CURRENT OFFSET:
     * whatever now occupies the viewport stays where it is. A jump to
     * the top would decide FOR the user in the one moment we ourselves
     * do not know what happened.
     */
    onChange: (instance) => {
      void instance;
    },
  });
  // (declared here, RUNS below lastVirtualIndex — the effects read it)
  const virtualItems = rowVirtualizer.getVirtualItems();
  const lastVirtualIndex = virtualItems.length
    ? virtualItems[virtualItems.length - 1].index
    : -1;
  useRowAnchoring({
    listRef,
    queue,
    virtualItems,
    lastVirtualIndex,
    rowVirtualizer,
  });
  // ONE measure callback for the whole list — a fresh arrow per row
  // would ride the props and fell every row's memo on every parent
  // render. measureElement resolves the row by its data-index, so the
  // single function serves all rows.
  const measureRow = useCallback(
    (el: HTMLLIElement | null) => {
      rowVirtualizer.measureElement(el);
    },
    // The virtualizer instance is stable for the mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

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
  const checkPaging = useCallback(() => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    lastVirtualIndex,
    workspace.hasMore,
    workspace.loadMore,
    other.hasMore,
    other.loadMore,
    workspaceRowCount,
    queue.length,
  ]);
  useEffect(() => {
    checkPaging();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkPaging, workspace.hits.length, other.hits.length]);

  // FOCUS TRANSFER: if the focused element lived inside a row that just
  // UNMOUNTED (scrolled out of the window), focus fell to <body> — the
  // tab walk restarts at the page top and the keyboard context is lost.
  // The transfer lands focus on the LIST CONTAINER: the walk's place is
  // kept, the next Tab enters the nearest visible row. The overscan buffer
  // (`OVERSCAN_ROWS` rows) covers stepping; this covers the fling past it.
  // Asymmetry argument
  // (the circle's): the unmount-with-focus case is rare, while a lost
  // focus on every focused scroll would meet the same person
  // constantly.
  //
  // CONDITIONAL BY CONSTRUCTION: the transfer fires ONLY for the
  // remembered, focused ELEMENT of a row — never because a mutation
  // happened while activeElement happened to be body. The first cut
  // here focused the list on ANY child mutation with focus in body:
  // an ordinary mouse scroll (nothing ever focused in a row) landed a
  // page and the list STOLE the focus. The remembered element is kept
  // by a focusin listener (a passive post-render read misses focus
  // set between renders), keyed by the row's COMPOSITE key — the row
  // title alone (sessionId) never matched the window's
  // agent:sessionId identities, so the old comparison described
  // nothing.
  const focusedElRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      focusedElRef.current =
        target?.closest?.(".history__row") ? target : null;
    };
    // LEAVING the list clears the memory — but ONLY on a REAL move:
    // focusout's relatedTarget tells where focus went. We TREAT a
    // null relatedTarget as removal — a CONSERVATIVE CHOICE, not a
    // signature: by spec, relatedTarget is also null when focus
    // leaves for another browsing context or when no focusable target
    // follows, so a real departure CAN arrive with a null target and
    // leave the memory stale (a later removal with focus in body
    // would then return focus to the list — the known edge, kept
    // over the alternative of clearing on every focusout, which
    // would break the observer's removal branch: when a node is
    // REMOVED there may be no focusout at all, and a removal-fired
    // one carries null without the user having gone anywhere). So:
    // clear only when focus verifiably LANDED outside the list;
    // null keeps the memory for the observer to act on.
    const onFocusOut = (e: FocusEvent) => {
      const wentTo = e.relatedTarget as HTMLElement | null;
      if (wentTo && !list.contains(wentTo)) {
        focusedElRef.current = null;
      }
    };
    list.addEventListener("focusin", onFocusIn);
    list.addEventListener("focusout", onFocusOut);
    return () => {
      list.removeEventListener("focusin", onFocusIn);
      list.removeEventListener("focusout", onFocusOut);
      focusedElRef.current = null;
    };
  }, []);
  // The transfer: a REMOVED focused node fires no focusout in every
  // engine, so removals are watched. The transfer lands ONLY when BOTH
  // hold: the removed subtree contained the REMEMBERED focused
  // element (a focusin-remembered node of a row — an ordinary scroll
  // that never focused a row transfers NOTHING), AND the browser
  // already dropped focus to body (another target means the user
  // moved on — not ours to move). This is CONDITIONAL by
  // construction; the first cut here focused the list on any
  // mutation with focus in body and stole focus from plain mouse scrolls —
  // pinned by the negative witness in the suite.
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      const remembered = focusedElRef.current;
      if (
        remembered &&
        !remembered.isConnected &&
        document.activeElement === document.body
      ) {
        list.focus({ preventScroll: true });
        focusedElRef.current = null;
      }
      // Anything else — nothing remembered, still connected, focus
      // elsewhere — is not a transfer case.
    });
    observer.observe(list, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  const onListScroll = () => {
    rowVirtualizer.measure();
    checkPaging();
  };

  return {
    virtualItems,
    lastVirtualIndex,
    totalSize: rowVirtualizer.getTotalSize(),
    measureRow,
    onListScroll,
    checkPaging,
  };
}
