import { useCallback, useEffect, useRef, useState } from "react";
import { describeError, log } from "../ipc/log";

/** Lazy paging ([F8]): the first page fills the viewport, later pages load as
 * the user nears the list's end — no cap on how far they can walk. Shared by
 * the global sessions browser and the spawn dialog's "Start from" picker. */
export const FIRST_PAGE = 50;
export const NEXT_PAGE = 20;

/** One page of results plus the full match count ("shown X of N"). */
export interface Page<T> {
  rows: T[];
  total: number;
}

/** Fetch page zero (`offset` 0) or a later page for a query. The caller bakes
 * in whatever scoping the source needs (all agents, or one). */
export type FetchPage<T> = (
  query: string,
  limit: number,
  offset: number,
) => Promise<Page<T>>;

export interface PagedSearch<T> {
  /** Loaded pages of rows for the current query, in match order. */
  rows: T[];
  /** Full match count for the query — the "shown X of N" denominator. */
  total: number;
  /** More matches exist beyond the loaded pages. */
  hasMore: boolean;
  /** A `loadMore` page is in flight (guards the scroll sentinel). */
  loadingMore: boolean;
  /** The query the rows answer. */
  query: string;
  /** Run the debounced search; resets paging to page zero. */
  search(query: string): void;
  /** Append the next page for the current query. */
  loadMore(): void;
  /** Re-fetch page zero for the current query WITHOUT shrinking below what's
   * already loaded — for a post-scan refresh, and the initial listing. */
  refresh(): void;
}

/**
 * The paging engine behind both session lists: page-zero on search, append on
 * `loadMore`, a sequence guard so a stale page never renders under a newer
 * query, and a `refresh` that re-reads the walked span without collapsing it.
 * IPC-free — the row source is injected as `fetchPage`, so each consumer scopes
 * and shapes its own rows (SearchHit for the browser, SessionPickRow for the
 * picker) while the state machine stays one implementation.
 */
export function usePagedSessionSearch<T>(
  fetchPage: FetchPage<T>,
  debounceMs = 150,
): PagedSearch<T> {
  // Always call through the latest fetcher: the picker's is agent-scoped and
  // changes as the user switches agent, but `search`/`loadMore`/`refresh` stay
  // stable so effects don't churn.
  const fetchRef = useRef(fetchPage);
  useEffect(() => {
    fetchRef.current = fetchPage;
  });

  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");

  const queryRef = useRef("");
  const rowsRef = useRef<T[]>([]);
  const totalRef = useRef(0);
  const loadingMoreRef = useRef(false);
  // The generation of the latest REQUESTED page zero (bumped synchronously by
  // `search`/`refresh`). `loadedSeqRef` is the generation the current `rows`
  // actually belong to (set when a page zero lands). While they differ, a
  // search is pending or its page zero is still in flight.
  const searchSeq = useRef(0);
  const loadedSeqRef = useRef(0);
  const debounce = useRef<number | null>(null);

  const apply = useCallback((next: T[], count: number) => {
    rowsRef.current = next;
    totalRef.current = count;
    setRows(next);
    setTotal(count);
  }, []);

  /** Fetch page zero. `atLeast` widens the page so a post-scan refresh never
   * shrinks what the user already scrolled into view. */
  const runSearch = useCallback(
    (q: string, atLeast = 0) => {
      // The caller (`search`/`refresh`) has already advanced the generation.
      const seq = searchSeq.current;
      void fetchRef
        .current(q, Math.max(FIRST_PAGE, atLeast), 0)
        .then((page) => {
          if (searchSeq.current !== seq) return;
          loadedSeqRef.current = seq;
          apply(page.rows, page.total);
        })
        .catch((e) =>
          log.warn("web:history", `search failed: ${describeError(e)}`),
        );
    },
    [apply],
  );

  const search = useCallback(
    (q: string) => {
      queryRef.current = q;
      setQuery(q);
      // Advance the generation NOW, not when the debounced fetch fires: it
      // marks the loaded rows stale immediately, so a `loadMore` fired during
      // the debounce window can't splice the new query's (or new agent's) page
      // onto the old rows.
      searchSeq.current += 1;
      if (debounce.current !== null) window.clearTimeout(debounce.current);
      debounce.current = window.setTimeout(() => {
        debounce.current = null;
        runSearch(q);
      }, debounceMs);
    },
    [runSearch, debounceMs],
  );

  const loadMore = useCallback(() => {
    if (loadingMoreRef.current) return;
    // The loaded rows must belong to the CURRENT generation. If a search is
    // pending, or its page zero hasn't landed yet, paging would append the new
    // request's page onto stale rows — wait for page zero instead.
    if (loadedSeqRef.current !== searchSeq.current) return;
    if (rowsRef.current.length >= totalRef.current) return; // nothing beyond
    const seq = searchSeq.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    void fetchRef
      .current(queryRef.current, NEXT_PAGE, rowsRef.current.length)
      .then((page) => {
        if (searchSeq.current !== seq) return; // query changed mid-flight
        apply([...rowsRef.current, ...page.rows], page.total);
      })
      .catch((e) =>
        log.warn("web:history", `load more failed: ${describeError(e)}`),
      )
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [apply]);

  const refresh = useCallback(() => {
    // A refresh is a new page-zero generation too — it drops any in-flight
    // page and re-anchors what `loadMore` is allowed to extend.
    searchSeq.current += 1;
    // Cancel a debounced search: refresh re-runs the current query right now,
    // so letting the timer fire too would issue a second, same-generation
    // page zero (both pass the landing guard → last-landed-wins width flicker).
    if (debounce.current !== null) {
      window.clearTimeout(debounce.current);
      debounce.current = null;
    }
    runSearch(queryRef.current, rowsRef.current.length);
  }, [runSearch]);

  // Cancel a pending debounced search on unmount: the spawn dialog's picker
  // mounts/unmounts per dialog, so a close mid-type would otherwise fire a
  // fetch and a no-op setState on the dead hook.
  useEffect(() => {
    return () => {
      if (debounce.current !== null) window.clearTimeout(debounce.current);
    };
  }, []);

  return {
    rows,
    total,
    hasMore: rows.length < total,
    loadingMore,
    query,
    search,
    loadMore,
    refresh,
  };
}
