import { useMemo, useRef } from "react";
import type { AgentInfo } from "../../../domain/agents";
import {
  composeSessionList,
  rowKeyOf,
  rowOfHit,
  type SessionRecord,
  type UnifiedSessionRow,
} from "../../../domain/journal";
import type { SessionsBrowserApi } from "../../../app/useSessionsBrowser";

interface SessionListCompositionInput {
  api: SessionsBrowserApi;
  agents: AgentInfo[];
  rows: SessionRecord[];
}

/** Compose the browser's two ordered lanes and keep unchanged row objects
 * stable across unrelated renders. The list counter comes from the same
 * composed snapshot as the rows, so the field and the virtual queue cannot
 * describe different populations. */
export function useSessionListComposition({
  api,
  agents,
  rows,
}: SessionListCompositionInput) {
  // The list's composition lives in the domain (`composeSessionList`)
  // — one entry point owning the query predicate, the union, the dedup,
  // the time axis AND the counters (numerator the drawn rows,
  // denominator what the list can draw, twins out): the view feeds it
  // and draws what it returns, counters included. MEMOIZED on its
  // inputs: the row OBJECTS it builds are what every SessionRowView
  // receives as props — rebuilding them per render would re-render the
  // whole list for nothing. A landed page changes the hits arrays and
  // re-builds (correctly); an unrelated re-render (a transcript page
  // landing, a viewer open) reuses the SAME row objects.
  const composed = useMemo(
    () =>
      composeSessionList({
        records: rows,
        query: api.query.trim(),
        entries: api.enrichment.entries,
        agentLabel: (agentId) => agents.find((a) => a.id === agentId)?.label,
        answerMayChange: api.scanning || api.enrichment.pending,
        workspaceHits: api.workspace.hits.map(rowOfHit),
        otherHits: api.other.hits.map(rowOfHit),
        workspaceTotal: api.workspace.total,
        otherTotal: api.other.total,
      }),
    // The hits arrays ride by LENGTH + first/last identity is not
    // enough (a page may replace contents at the same length); the
    // arrays themselves are the engines' state — new page, new array.
    [
      rows,
      api.query,
      api.enrichment.entries,
      api.enrichment.pending,
      api.scanning,
      api.workspace.hits,
      api.other.hits,
      api.workspace.total,
      api.other.total,
      agents,
    ],
  );
  const workspaceRowsAll = composed.workspace.rows;
  const otherRowsAll = composed.other.rows;

  // ROW-OBJECT STABILITY: the composition rebuilds every row object on
  // every recomputation (pure and stateless — correct for the domain),
  // but a rebuilt OBJECT invalidates the memoized row even when nothing
  // in it changed. This cache re-issues the PREVIOUS object when the
  // row's SOURCES are the same references — the journal record + its
  // enrichment entry for a bound row, the index hit for an index row —
  // so a landed page re-renders exactly its new rows, and an enrichment
  // landing re-renders exactly the rows whose answers changed. Bounded
  // by the distinct keys the list ever showed.
  const rowCacheRef = useRef(new Map<string, UnifiedSessionRow>());
  const stabilize = (row: UnifiedSessionRow, source: unknown): UnifiedSessionRow => {
    const key = rowKeyOf(row);
    const cached = rowCacheRef.current.get(key) as
      | (UnifiedSessionRow & { __src?: unknown })
      | undefined;
    if (cached !== undefined && cached.__src === source) return cached;
    const stamped = row as UnifiedSessionRow & { __src?: unknown };
    stamped.__src = source;
    rowCacheRef.current.set(key, stamped);
    return stamped;
  };
  // A row's SOURCE PAIR: for a bound row the journal record + its
  // enrichment entry + the answer's mutability (an answer flips
  // indexing→settled verdicts; caching across THAT would freeze the
  // status chip); for an index row the hit object itself. MEMOIZED on
  // the REAL sources — an unrelated state change (the clock's own tick
  // included) must not
  // rebuild these maps or the stabilized arrays below, or "the tick
  // only touches the visible rows" would be a promise, not a fact.
  const answerMutable = api.scanning || api.enrichment.pending;
  const sources = useMemo(() => {
    const hitByKey = new Map<string, unknown>();
    for (const h of api.workspace.hits) hitByKey.set(rowKeyOf(h), h);
    for (const h of api.other.hits) hitByKey.set(rowKeyOf(h), h);
    const recordByKey = new Map(rows.map((r) => [rowKeyOf(r), r]));
    const entries = api.enrichment.entries;
    const sourceOfKey = (key: string): unknown =>
      recordByKey.has(key)
        ? `${String(answerMutable)}:${String(
            entries.get(key) === undefined,
          )}:${String(recordByKey.get(key))}:${String(entries.get(key))}`
        : hitByKey.get(key);
    return { sourceOfKey };
    // The hits arrays and entries are the engines'/table's own state:
    // a new page or a landed answer is a new reference — exactly when
    // the source map SHOULD rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, api.workspace.hits, api.other.hits, api.enrichment.entries, answerMutable]);
  const workspaceRows = useMemo(
    () => workspaceRowsAll.map((row) => stabilize(row, sources.sourceOfKey(rowKeyOf(row)))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceRowsAll, sources],
  );
  const otherRows = useMemo(
    () => otherRowsAll.map((row) => stabilize(row, sources.sourceOfKey(rowKeyOf(row)))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [otherRowsAll, sources],
  );

  return {
    workspaceRows,
    otherRows,
    listCount: composed.listCount,
    emptyList: workspaceRows.length === 0 && otherRows.length === 0,
  };
}
