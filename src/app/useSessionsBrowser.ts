import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { AgentTranscriptEntry } from "@keepdeck/plugin-api";
import {
  indexSearch,
  type IndexFolderScope,
  type SearchHit,
} from "../ipc/history";
import type { JoinEntry } from "../domain/journal";
import { useAppRuntime } from "./runtimeContext";
import { useJournalEnrichment, type RowKey } from "./useJournalEnrichment";
import { usePagedSessionSearch } from "./usePagedSessionSearch";

/** One block's search state: its own pages, its own totals — the numerator
 * and the denominator of a block's counter come from ITS response, never
 * stitched together from two. */
export interface BlockApi {
  hits: SearchHit[];
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  /** Page zero of this block's current query is in flight — its OWN
   * pending, for per-block needs; the list-level flag composes both. */
  firstPagePending: boolean;
  error: string | null;
  loadMore(): void;
}

/** The SHARED half of the browser seam — ONE instance for the whole app
 * (built in the controller): the journal join's keyed answer table and
 * the freshness wiring. Single-instance is the load-bearing part: several
 * browsers stay mounted (hidden, not unmounted), and a keyed table shared
 * across them is what keeps answers landing on rows, never on "the last
 * response". The per-workspace halves (the folder-scoped engines) live in
 * each browser — membership in the query made them workspace-shaped BY
 * DESIGN. */
export interface BrowserSharedSeam {
  scanning: boolean;
  /** The index's revision as the seam sees it — per-browser refresh
   * effects key on it WITHOUT each browser subscribing twice. */
  revision: number;
  /** The agents whose stores the LAST SETTLED scan walked — the
   * `file-erased` verdict's precondition: an agent absent here was never
   * looked at, and its absence from the index proves nothing. */
  scannedAgents: ReadonlySet<string>;
  /** The "agent:sessionId" keys the last settled scan PRUNED — sessions
   * that were indexed and are not anymore. The enrichment cache devalues
   * exactly these hits; identity moves only when something dropped. */
  invalidated: ReadonlySet<string>;
  enrichment: {
    entries: ReadonlyMap<string, JoinEntry>;
    /** The table may still change (an ask in flight, or the index moved
     * since the last landing) — the join keeps `absent` provisional
     * while true, so a scan's end never flashes "nothing to read". */
    pending: boolean;
    /** Declare the keys this list's journal rows need. Idempotent,
     * union across lists; triggers the shared batched ask. */
    declare(keys: ReadonlyArray<RowKey>): void;
  };
  /** Declare the need for a fresh index; the sessionIndexManager owns
   * when a scan actually runs. */
  ensureFresh(): void;
  /** One transcript page, via the owning plugin (live parse — the index
   * never renders transcripts). */
  transcript(
    agent: string,
    ref: string,
    offset: number,
    limit: number,
  ): Promise<AgentTranscriptEntry[]>;
}

export interface SessionsBrowserApi {
  /** The workspace block: index hits from the workspace's OWN folders. */
  top: BlockApi;
  /** The global block: index hits from everywhere BUT those folders. */
  bottom: BlockApi;
  /** The query both blocks answer — per browser: the box a workspace
   * shows is its own, and the blocks' results are workspace-shaped
   * anyway. */
  query: string;
  /** Results of the CURRENT query are still riding: true while EITHER
   * block's first page is in flight — with two scoped queries, "the
   * results I asked for" is both of them, and a flag per block would
   * flicker apart over one shared search box. */
  firstPagePending: boolean;
  scanning: boolean;
  /** The settled scan's participants — see
   * [`BrowserSharedSeam.scannedAgents`]. */
  scannedAgents: ReadonlySet<string>;
  /** The journal rows' shared enrichment table — see
   * [`BrowserSharedSeam.enrichment`]. */
  enrichment: BrowserSharedSeam["enrichment"];
  /** Run the debounced search on BOTH blocks; resets each block's paging. */
  search(query: string): void;
  ensureFresh(): void;
  transcript(
    agent: string,
    ref: string,
    offset: number,
    limit: number,
  ): Promise<AgentTranscriptEntry[]>;
}

/** The shared seam's single owner: mount ONCE in the controller. */
export function useBrowserSharedSeam(): BrowserSharedSeam {
  const { plugins, sessionIndex } = useAppRuntime();
  const index = useSyncExternalStore(sessionIndex.subscribe, sessionIndex.snapshot);
  const enrichment = useJournalEnrichment(
    index.revision,
    index.scanning,
    index.invalidated,
  );
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
      return (
        contribution.entry.history as {
          transcript(
            ref: string,
            page: { offset: number; limit: number },
          ): Promise<AgentTranscriptEntry[]>;
        }
      ).transcript(ref, { offset, limit });
    },
    [plugins],
  );
  return {
    scanning: index.scanning,
    revision: index.revision,
    scannedAgents: index.scannedAgents,
    invalidated: index.invalidated,
    enrichment,
    ensureFresh,
    transcript,
  };
}

/** The per-browser half: two folder-scoped engines over ONE query text.
 * `dirs` is the workspace's directory set as the webview's domain computes
 * it (own folder ∪ pane folders ∪ folders from its journal history) —
 * the top block asks Only, the bottom Except, so membership rides in the
 * queries and each block pages over its own set, fetching nothing it will
 * throw away. */
export function useSessionsBrowser(
  dirs: ReadonlySet<string>,
  shared: BrowserSharedSeam,
): SessionsBrowserApi {
  const dirList = [...dirs];
  const scopeKey = dirList.join("\n");
  const scopeOf = useCallback(
    (mode: "only" | "except"): IndexFolderScope => ({
      mode,
      dirs: scopeKey === "" ? [] : scopeKey.split("\n"),
    }),
    [scopeKey],
  );
  const top = usePagedSessionSearch<SearchHit>(
    useCallback(
      (query, limit, offset) =>
        indexSearch(query, limit, offset, undefined, scopeOf("only")).then(
          (page) => ({ rows: page.hits, total: page.total }),
        ),
      [scopeOf],
    ),
  );
  const bottom = usePagedSessionSearch<SearchHit>(
    useCallback(
      (query, limit, offset) =>
        indexSearch(query, limit, offset, undefined, scopeOf("except")).then(
          (page) => ({ rows: page.hits, total: page.total }),
        ),
      [scopeOf],
    ),
  );
  const { refresh: refreshTop } = top;
  const { refresh: refreshBottom } = bottom;
  const { resetTo: resetTopTo } = top;
  const { resetTo: resetBottomTo } = bottom;
  const { scanning } = shared;

  // Each block re-reads page zero on every index REVISION: the mount fire
  // is the initial listing, and later bumps are landed scan batches — a
  // first-ever scan fills the blocks while it runs instead of after it
  // (the filling-while-scanning the user chose).
  useEffect(() => {
    refreshTop();
    refreshBottom();
  }, [shared.revision, refreshTop, refreshBottom]);

  // A SCOPE CHANGE is a new QUESTION, not a refresh: the folder set the
  // asks carry has moved, so the old rows answer an area nobody asks
  // about anymore. `resetTo` starts a fresh page zero under a new
  // generation AND clears the old rows in the same tick — they cannot
  // survive even the debounce window, and a later page cannot splice
  // onto them at their old length. Reachable on every cold start where
  // the journal settles after the screen mounts (the empty-set window is
  // {ws.cwd} until it does), and the narrow ask only needs to have been
  // REQUESTED inside the window — a late landing would otherwise paint
  // the old area through the unbumped generation. NOT identity-
  // stabilizing the set: that treats a different disease (spurious
  // rescopes) and would leave this one.
  const scopeRef = useRef(scopeKey);
  useEffect(() => {
    if (scopeRef.current === scopeKey) return;
    scopeRef.current = scopeKey;
    resetTopTo(top.query);
    resetBottomTo(bottom.query);
    // The engine query states are read fresh inside; the callbacks only
    // need to be the engines' own stable ones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  const search = useCallback(
    (query: string) => {
      // One text, two asks — the blocks' query states are set
      // synchronously and identically by their engines, so the box and
      // both results always agree on what was typed.
      top.search(query);
      bottom.search(query);
    },
    [top, bottom],
  );

  return {
    top: {
      hits: top.rows,
      total: top.total,
      hasMore: top.hasMore,
      loadingMore: top.loadingMore,
      firstPagePending: top.firstPagePending,
      error: top.error,
      loadMore: top.loadMore,
    },
    bottom: {
      hits: bottom.rows,
      total: bottom.total,
      hasMore: bottom.hasMore,
      loadingMore: bottom.loadingMore,
      firstPagePending: bottom.firstPagePending,
      error: bottom.error,
      loadMore: bottom.loadMore,
    },
    query: top.query,
    firstPagePending: top.firstPagePending || bottom.firstPagePending,
    scanning,
    scannedAgents: shared.scannedAgents,
    enrichment: shared.enrichment,
    search,
    ensureFresh: shared.ensureFresh,
    transcript: shared.transcript,
  };
}
