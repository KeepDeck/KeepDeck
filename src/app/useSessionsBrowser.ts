import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { AgentTranscriptEntry } from "@keepdeck/plugin-api";
import { indexSearch, type SearchHit } from "../ipc/history";
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
  /** Declare the need for a fresh index — every agent's store (no agent)
   * or one agent's. The sessionIndexManager owns when a scan actually
   * runs; this listing refreshes per revision on its own. */
  ensureFresh(agent?: string): void;
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
 * Rust index only; transcripts go through the agent plugins. Paging is the
 * shared engine, scoped to ALL agents (no `agent` filter). Index freshness
 * is NOT this hook's to manage — it subscribes to the runtime's
 * sessionIndexManager and refreshes on every revision bump. */
export function useSessionsBrowser(): SessionsBrowserApi {
  const { plugins, sessionIndex } = useAppRuntime();
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
  const index = useSyncExternalStore(sessionIndex.subscribe, sessionIndex.snapshot);

  // The listing re-reads page zero on every index REVISION: the mount fire
  // is the initial listing, and later bumps are landed scan batches — a
  // first-ever scan fills the list while it runs instead of after it. Runs
  // ONCE here, not on browser mount — a second empty workspace mounting the
  // browser must not clobber a shared query another instance is mid-typing.
  useEffect(() => {
    refresh();
  }, [index.revision, refresh]);

  const ensureFresh = useCallback(
    (agent?: string) => sessionIndex.ensureFresh(agent),
    [sessionIndex],
  );

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
    scanning: index.scanning,
    search: paged.search,
    loadMore: paged.loadMore,
    ensureFresh,
    transcript,
  };
}
