import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentTranscriptEntry } from "@keepdeck/plugin-api";
import { indexSearch, type SearchHit } from "../ipc/history";
import { describeError, log } from "../ipc/log";
import { scanAgentHistories } from "./historyScan";
import { useAppRuntime } from "./runtimeContext";

/** Lazy paging ([F8]): the first page fills the viewport, later pages load
 * as the user nears the list's end — no cap on how far they can walk. */
export const FIRST_PAGE = 50;
export const NEXT_PAGE = 20;

export interface SessionsBrowserApi {
  /** Loaded pages of hits for the current query, in match order. */
  hits: SearchHit[];
  /** Full match count for the query — the "shown X of N" denominator. */
  total: number;
  /** More matches exist beyond the loaded pages. */
  hasMore: boolean;
  /** A `loadMore` page is in flight (guards the scroll sentinel). */
  loadingMore: boolean;
  /** The query the hits answer — lives HERE so every empty-workspace mount
   * of the browser shows box and results in agreement (hits are shared;
   * per-instance query state desynced them). */
  query: string;
  scanning: boolean;
  /** Run the debounced search; called on every keystroke. Resets paging. */
  search(query: string): void;
  /** Append the next page for the current query. */
  loadMore(): void;
  /** Store scan, then refresh the current results. Incremental at the STAT
   * level: sessions are re-read when the (ref, mtime, size) fingerprint the
   * plugin's `list()` reports differs from the index — an in-place rewrite
   * preserving both stamps would be missed until either moves. Safe to call
   * on browser mount. */
  scan(): void;
  /** One transcript page, via the owning plugin (live parse — the index
   * never renders transcripts). */
  transcript(
    agent: string,
    ref: string,
    offset: number,
    limit: number,
  ): Promise<AgentTranscriptEntry[]>;
}

/** The global sessions browser's engine ([F8]): search-as-you-type hits the
 * Rust index only; scans and the viewer go through the agent plugins. */
export function useSessionsBrowser(): SessionsBrowserApi {
  const { plugins } = useAppRuntime();
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [scanning, setScanning] = useState(false);
  const queryRef = useRef("");
  const [query, setQuery] = useState("");
  const searchSeq = useRef(0);
  const debounce = useRef<number | null>(null);
  const scanningRef = useRef(false);
  const hitsRef = useRef<SearchHit[]>([]);
  const totalRef = useRef(0);
  const loadingMoreRef = useRef(false);

  const applyHits = useCallback((rows: SearchHit[], total: number) => {
    hitsRef.current = rows;
    totalRef.current = total;
    setHits(rows);
    setTotal(total);
  }, []);

  /** Fetch page zero. `atLeast` widens the page so a post-scan refresh never
   * shrinks what the user already scrolled into view. */
  const runSearch = useCallback(
    (query: string, atLeast = 0) => {
      const seq = ++searchSeq.current;
      void indexSearch(query, Math.max(FIRST_PAGE, atLeast), 0)
        .then((page) => {
          if (searchSeq.current !== seq) return;
          applyHits(page.hits, page.total);
        })
        .catch((e) =>
          log.warn("web:history", `search failed: ${describeError(e)}`),
        );
    },
    [applyHits],
  );

  const search = useCallback(
    (query: string) => {
      queryRef.current = query;
      setQuery(query);
      if (debounce.current !== null) window.clearTimeout(debounce.current);
      debounce.current = window.setTimeout(() => runSearch(query), 150);
    },
    [runSearch],
  );

  const loadMore = useCallback(() => {
    if (loadingMoreRef.current) return;
    if (hitsRef.current.length >= totalRef.current) return; // nothing beyond
    const seq = searchSeq.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    void indexSearch(queryRef.current, NEXT_PAGE, hitsRef.current.length)
      .then((page) => {
        if (searchSeq.current !== seq) return; // query changed mid-flight
        applyHits([...hitsRef.current, ...page.hits], page.total);
      })
      .catch((e) =>
        log.warn("web:history", `load more failed: ${describeError(e)}`),
      )
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [applyHits]);

  const scan = useCallback(() => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setScanning(true);
    const sources = plugins.pluginRegistries.agents
      .list()
      .flatMap((c) =>
        c.entry.history
          ? [{ agentId: c.entry.id, history: c.entry.history }]
          : [],
      );
    const refresh = () => runSearch(queryRef.current, hitsRef.current.length);
    void scanAgentHistories(sources, undefined, refresh)
      .catch((e) => log.warn("web:history", `scan failed: ${describeError(e)}`))
      .finally(() => {
        scanningRef.current = false;
        setScanning(false);
        refresh();
      });
  }, [plugins, runSearch]);

  // The initial listing runs ONCE here, not on browser mount — a second
  // empty workspace mounting the browser must not clobber a shared query
  // another instance is mid-typing.
  useEffect(() => {
    runSearch(queryRef.current);
  }, [runSearch]);

  const transcript = useCallback(
    async (agent: string, ref: string, offset: number, limit: number) => {
      const contribution = plugins.pluginRegistries.agents
        .list()
        .find((c) => c.entry.id === agent);
      if (!contribution?.entry.history) return [];
      return contribution.entry.history.transcript(ref, { offset, limit });
    },
    [plugins],
  );

  return {
    hits,
    total,
    hasMore: hits.length < total,
    loadingMore,
    query,
    scanning,
    search,
    loadMore,
    scan,
    transcript,
  };
}
