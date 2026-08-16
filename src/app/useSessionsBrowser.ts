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
  /** Page zero failed for the current query — `hits` is empty, not stale.
   * The browser names it instead of claiming "No sessions match". */
  error: string | null;
  scanning: boolean;
  /** Run the debounced search; called on every keystroke. Resets paging. */
  search(query: string): void;
  /** Append the next page for the current query. */
  loadMore(): void;
  /** Store scan, then refresh the current results. Incremental at the STAT
   * level: sessions are re-read when the (ref, mtime, size) fingerprint the
   * plugin's `list()` reports differs from the index — an in-place rewrite
   * preserving both stamps would be missed until either moves. Safe to call
   * on browser mount. With `agent`, scans only that agent's store — the
   * spawn-dialog picker's scope; `onProgress` then also fires for the CALLER
   * (per landed batch and at settle) alongside this hook's own refresh. */
  scan(agent?: string, onProgress?: () => void): void;
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
  const scanRef = useRef<Promise<void> | null>(null);
  // Lets `scan` chain a request behind the running one without self-refering
  // to its own useCallback; assigned during render like `deckRef` in
  // useAgentDialog.
  const scanFnRef = useRef<(agent?: string, onProgress?: () => void) => void>(
    () => {},
  );

  const scan = useCallback(
    (agent?: string, onProgress?: () => void) => {
      const settle = () => onProgress?.();
      const running = scanRef.current;
      if (running) {
        // Don't drop a request the running scan may not cover: a picker's
        // single-agent scan can't stand in for the browser's full sweep (or a
        // picker switched to another agent). Run this request once the
        // running one settles — a then-current scan re-chains the same way.
        void running.then(
          () => scanFnRef.current(agent, onProgress),
          () => scanFnRef.current(agent, onProgress),
        );
        return;
      }
      setScanning(true);
      const sources = plugins.pluginRegistries.agents
        .list()
        .flatMap((c) =>
          c.entry.history
            ? [{ agentId: c.entry.id, history: c.entry.history }]
            : [],
        )
        .filter((s) => agent === undefined || s.agentId === agent);
      scanRef.current = scanAgentHistories(sources, undefined, () => {
        refresh();
        settle();
      })
        .catch((e) => log.warn("web:history", `scan failed: ${describeError(e)}`))
        .finally(() => {
          scanRef.current = null;
          setScanning(false);
          refresh();
          settle();
        });
    },
    [plugins, refresh],
  );
  scanFnRef.current = scan;

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
    error: paged.error,
    scanning,
    search: paged.search,
    loadMore: paged.loadMore,
    scan,
    transcript,
  };
}
