import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentTranscriptEntry } from "@keepdeck/plugin-api";
import { indexSearch, type SearchHit } from "../ipc/history";
import { describeError, log } from "../ipc/log";
import { scanAgentHistories } from "./historyScan";
import { useAppRuntime } from "./runtimeContext";
import { usePagedSessionSearch } from "./usePagedSessionSearch";

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
 * Rust index only; scans and the viewer go through the agent plugins. Paging
 * is the shared engine, scoped to ALL agents (no `agent` filter). */
export function useSessionsBrowser(): SessionsBrowserApi {
  const { plugins } = useAppRuntime();
  const paged = usePagedSessionSearch<SearchHit>(
    useCallback(
      (query, limit, offset) =>
        indexSearch(query, limit, offset).then((page) => ({
          rows: page.hits,
          total: page.total,
        })),
      [],
    ),
  );
  const { refresh } = paged;
  const [scanning, setScanning] = useState(false);
  const scanningRef = useRef(false);

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
    void scanAgentHistories(sources, undefined, refresh)
      .catch((e) => log.warn("web:history", `scan failed: ${describeError(e)}`))
      .finally(() => {
        scanningRef.current = false;
        setScanning(false);
        refresh();
      });
  }, [plugins, refresh]);

  // The initial listing runs ONCE here, not on browser mount — a second
  // empty workspace mounting the browser must not clobber a shared query
  // another instance is mid-typing. `refresh` reads page zero for the
  // current (empty) query.
  useEffect(() => {
    refresh();
  }, [refresh]);

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
    hits: paged.rows,
    total: paged.total,
    hasMore: paged.hasMore,
    loadingMore: paged.loadingMore,
    query: paged.query,
    scanning,
    search: paged.search,
    loadMore: paged.loadMore,
    scan,
    transcript,
  };
}
