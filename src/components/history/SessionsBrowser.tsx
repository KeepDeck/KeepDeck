import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dirPresent, useDirPresence } from "./useDirPresence";
import type { AgentTranscriptEntry } from "@keepdeck/plugin-api";
import type { AgentInfo } from "../../domain/agents";
import {
  composeSessionList,
  handleFromHit,
  rowKeyOf,
  rowOfHit,
  type SessionHandle,
  type SessionRecord,
  type UnifiedSessionRow,
} from "../../domain/journal";
import type { SessionsBrowserApi } from "../../app/useSessionsBrowser";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useSessionsBrowser, type BrowserSharedSeam } from "../../app/useSessionsBrowser";
import { BackIcon } from "../../ui/icons";
import { NEAR_END } from "../../ui/useScrollPaging";
import { SessionRowView, SessionRowActions } from "./SessionRowView";

interface SessionsBrowserProps {
  api: SessionsBrowserApi;
  agents: AgentInfo[];
  /** The workspace's journal, newest binding first (`journalRows`). */
  rows: SessionRecord[];
  /** The agent plugins finished activating — before that a scan would see
   * an empty registry and "successfully" index zero stores. */
  ready: boolean;
  onResume(record: SessionHandle): void;
  onFork(record: SessionHandle): void;
}

/** The component DeckStage mounts: one browser per empty workspace, its
 * engines scoped to that workspace's directories, over the ONE shared
 * seam (keyed enrichment, freshness, transcript dispatch). */
export function WorkspaceSessionsBrowser({
  shared,
  dirs,
  agents,
  rows,
  ready,
  onResume,
  onFork,
}: Omit<SessionsBrowserProps, "api"> & {
  shared: BrowserSharedSeam;
  dirs: ReadonlySet<string>;
}) {
  const api = useSessionsBrowser(dirs, shared);
  return (
    <SessionsBrowser
      api={api}
      agents={agents}
      rows={rows}
      ready={ready}
      onResume={onResume}
      onFork={onFork}
    />
  );
}

/** The domain's hit→handle mapping under this file's historical name (the
 * spawn dialog's picker shares the same mapping via the domain export). */
export const hitRecord = handleFromHit;

/** Transcript paging's step sizes (the step strategy of the sessions
 * step, [F8]): fill the viewport first, then small increments as
 * scrolling nears the bottom. The viewer is NOT virtualized — it draws
 * every loaded turn; only its FETCHING is incremental. */
const FIRST_TURNS = 50;
const NEXT_TURNS = 20;

/** What the transcript viewer reads — one row's read link, whichever list
 * the row came from (a journal row or an index hit). Carries the row
 * itself: the header's actions render from the SAME availability rules
 * as the list row, not a re-derivation. */
interface ViewerTarget {
  agent: string;
  sessionId: string;
  reference: string;
  title: string | null;
  /** The row's read links in try order (the join's union: journal path
   * first, the index's reference as the spare), plus how many have
   * already refused. A failed page zero advances one link; the LAST
   * link's failure is the row's failure. Singleton for hit rows. */
  fallbacks: string[];
  tried: number;
  /** The row this target was opened from — the header's actions live
   * on it (one rule source with the list row). */
  row: UnifiedSessionRow;
}

/**
 * The empty-workspace sessions surface ([F8]): ONE list with the search bar
 * on top. The workspace's own journal pins first — the sessions that ran
 * here — below a divider every other session of every agent store,
 * searchable by content and title. Both blocks render the SAME row
 * component: the blocks differ by which side of the workspace boundary a
 * session sits on, never by markup. Search hits only the Rust index;
 * opening a row reads the transcript live through the owning plugin. Resume
 * runs in the session's ORIGINAL directory; Fork picks a new home.
 */
export function SessionsBrowser({
  api,
  agents,
  rows,
  ready,
  onResume,
  onFork,
}: SessionsBrowserProps) {
  const [open, setOpen] = useState<ViewerTarget | null>(null);
  const [entries, setEntries] = useState<AgentTranscriptEntry[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loadingPage, setLoadingPage] = useState(false);
  /** The viewer's own failure line — a refused read is named where it
   * happened, not rendered as an empty transcript. */
  const [viewerError, setViewerError] = useState<string | null>(null);
  /** Rows whose LAST read by link fell. The row stays and stays
   * openable — a retry is legitimate — but the failure is named on the
   * row, as itself and never as "nothing to read". */
  const [readFailed, setReadFailed] = useState<ReadonlySet<string>>(new Set());
  // Resume needs a live original directory — same gate for both tracks.
  const presence = useDirPresence([
    ...rows.map((row) => row.cwd),
    ...api.workspace.hits.map((hit) => hit.cwd),
    ...api.other.hits.map((hit) => hit.cwd),
  ]);
  // Orders transcript responses: a stale page must never render under a
  // newer row's header (the search path has searchSeq; this is its twin).
  const viewSeq = useRef(0);

  // The browser DECLARES its need for a fresh index; when the scan runs is
  // the sessionIndexManager's call (it also waits for plugin registration
  // on its own — this gate mirrors the surface's own readiness shape). The
  // listing itself refreshes per index revision inside the hook.
  useEffect(() => {
    if (ready) api.ensureFresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // The journal rows' keys go to the SHARED enrichment table — the ask
  // policy (one batched lookup per change, keyed answers) lives in the
  // seam, not here. Idempotent: every mounted list declares its own rows.
  const declare = api.enrichment.declare;
  useEffect(() => {
    declare(rows.map((row) => ({ agent: row.agent, sessionId: row.sessionId })));
  }, [declare, rows]);

  // Lazy paging, driven by the VIRTUAL RANGE (never by a DOM node: the
  // last row of a track unmounts by definition once scrolled past). Two
  // SEPARATE thresholds, each asking only its own engine. The
  // virtualizer and the thresholds live below the composed rows —
  // they read the stabilized queue.
  const listRef = useRef<HTMLUListElement | null>(null);
  const PAGE_AHEAD = 40;
  const nearEnd = (el: HTMLElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END;

  /** One transcript read of `target` at `from`. A page-zero refusal falls
   * through to the row's NEXT read link (the union is a real fallback, not
   * a display priority): both links are opaque handles the row merely
   * carries — one can refuse while the other still serves the read. The
   * failure mark lands only when the LAST link refused too. */
  const loadMore = (target: ViewerTarget, from: number) => {
    const seq = viewSeq.current;
    const limit = from === 0 ? FIRST_TURNS : NEXT_TURNS;
    setLoadingPage(true);
    void api
      .transcript(target.agent, target.reference, from, limit)
      .then((page) => {
        if (viewSeq.current !== seq) return; // another row opened meanwhile
        setEntries((current) => (from === 0 ? page : [...current, ...page]));
        setExhausted(page.length < limit);
        // A good page retires the row's failure mark — a link reads.
        for (const link of target.fallbacks) {
          setReadFailed((current) => {
            if (!current.has(link)) return current;
            const next = new Set(current);
            next.delete(link);
            return next;
          });
        }
      })
      .catch((e: unknown) => {
        if (viewSeq.current !== seq) return;
        const next = target.fallbacks[target.tried + 1];
        if (from === 0 && next !== undefined) {
          // The refusal itself is not yet the row's verdict — a link of
          // the union remains untried. Advance one and retry page zero;
          // the viewer stays on the same row, so no state is reset.
          // `tried` advances monotonically: each refusal moves the cursor
          // past the link that refused, so the walk terminates on the
          // last link however many fall.
          loadMore({ ...target, reference: next, tried: target.tried + 1 }, 0);
          return;
        }
        // The read fell on the LAST link — every handle the row carries
        // refused its attempt. Named as itself, on the viewer AND on the
        // row; the row keeps its place. The mark is the ROW's verdict, so
        // it lands on every link
        // of the union: the first link alone must not read as alive when
        // its spare just refused too. Exhausted stops the viewer's fill-
        // the-viewport effect from re-requesting a link that just
        // refused — a retry comes from a fresh open.
        setViewerError(e instanceof Error ? e.message : String(e));
        setExhausted(true);
        setReadFailed((current) => {
          const next = new Set(current);
          for (const link of target.fallbacks) next.add(link);
          return next;
        });
      })
      .finally(() => {
        if (viewSeq.current === seq) setLoadingPage(false);
      });
  };

  // The transcript pages on scroll too (fill-then-increment, [F8]): nearing
  // the bottom fetches the next page; the mount-time check below keeps
  // filling while the loaded turns are shorter than the viewer.
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const maybeLoadPage = useCallback(() => {
    // loadingPage doubles as the in-flight guard: a scroll storm must not
    // fetch the same offset twice nor skip a page.
    if (!open || exhausted || loadingPage) return;
    const body = viewerRef.current;
    if (body && nearEnd(body)) loadMore(open, entries.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, exhausted, loadingPage, entries.length]);
  useEffect(() => {
    maybeLoadPage();
  }, [maybeLoadPage]);

  const openViewer = (target: ViewerTarget) => {
    viewSeq.current += 1;
    setOpen(target);
    setEntries([]);
    setExhausted(false);
    setLoadingPage(false);
    setViewerError(null);
    loadMore(target, 0);
  };

  /** Any unified row opens on its read link — the shown link first (a
   * click retries exactly what the row displays), the union chain behind
   * it for the fall-through. STABLE: one function for the whole list's
   * lifetime at this mount — a fresh one per render would re-render
   * every row that receives it. */
  const openRow = useCallback((row: UnifiedSessionRow) => {
    if (row.read === null) return;
    openViewer({
      agent: row.agent,
      sessionId: row.sessionId,
      reference: row.read.reference,
      title: row.title ?? null,
      fallbacks: row.readLinks,
      tried: 0,
      row,
    });
    // openViewer is a stable local over setState/useRef only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeViewer = () => {
    viewSeq.current += 1;
    setOpen(null);
    setLoadingPage(false);
  };

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
  // status chip); for an index row the hit object itself.
  const answerMutable = api.scanning || api.enrichment.pending;
  const hitByKey = new Map<string, unknown>();
  for (const h of api.workspace.hits) hitByKey.set(rowKeyOf(h), h);
  for (const h of api.other.hits) hitByKey.set(rowKeyOf(h), h);
  const recordByKey = new Map(rows.map((r) => [rowKeyOf(r), r]));
  const sourceOfKey = (key: string): unknown =>
    recordByKey.has(key)
      ? `${String(answerMutable)}:${String(
          api.enrichment.entries.get(key) === undefined,
        )}:${String(recordByKey.get(key))}:${String(api.enrichment.entries.get(key))}`
      : hitByKey.get(key);
  const workspaceRows = workspaceRowsAll.map((row) =>
    stabilize(row, sourceOfKey(rowKeyOf(row))),
  );
  const otherRows = otherRowsAll.map((row) =>
    stabilize(row, sourceOfKey(rowKeyOf(row))),
  );
  const emptyList = workspaceRows.length === 0 && otherRows.length === 0;

  // The virtualizer over the ONE flat queue (workspace rows, then other
  // rows — the composition's order, untouched). Dynamic measurement:
  // rows carry meta lines that wrap, so heights vary; estimate runs
  // before the first measure with a generous overshoot so the scrollbar
  // never undershoots. Keys are agent:sessionId — NEVER the index.
  const queue = useMemo(
    () => [...workspaceRows, ...otherRows],
    [workspaceRows, otherRows],
  );
  const rowVirtualizer = useVirtualizer({
    count: queue.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 72,
    overscan: 6,
    getItemKey: (index) => rowKeyOf(queue[index]),
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const lastVisibleIndex = virtualItems.length
    ? virtualItems[virtualItems.length - 1].index
    : -1;

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
  const maybeLoadBoth = useCallback(() => {
    if (lastVisibleIndex < 0) return;
    // The workspace track's tail asks ONLY its own engine.
    if (api.workspace.hasMore && workspaceRows.length > 0) {
      if (workspaceRows.length - 1 - lastVisibleIndex <= PAGE_AHEAD) {
        api.workspace.loadMore();
      }
    }
    // The list's overall tail asks ONLY the other engine.
    if (api.other.hasMore) {
      if (queue.length - 1 - lastVisibleIndex <= PAGE_AHEAD) {
        api.other.loadMore();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    lastVisibleIndex,
    api.workspace.hasMore,
    api.workspace.loadMore,
    api.other.hasMore,
    api.other.loadMore,
    workspaceRows.length,
    queue.length,
  ]);
  useEffect(() => {
    maybeLoadBoth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maybeLoadBoth, api.workspace.hits.length, api.other.hits.length]);
  const onListScroll = () => {
    rowVirtualizer.measure();
    maybeLoadBoth();
  };

  // One clock tick for the MOUNT — ages don't tick mid-render, and any
  // tick tied to the list's growth would invalidate every memoized row
  // on every landed page (the very cost this stabilization removes).
  // THE NAMED COST, not a side effect: this FREEZE is real. Before, the
  // tick refreshed incidentally on any re-render; now a row opened for
  // an hour says "2m ago" for that hour. Fine for "5d ago"; wrong-
  // looking for minutes-scale labels. Once the list is virtualized, a
  // SLOW tick (once a minute) would repaint only the visible rows and
  // cost almost nothing — whether to add it is an open question for the
  // next step's review, deliberately not decided here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), []);

  // STABLE action adapters: ONE pair for the whole mount, not one pair
  // per row per render — the rows receive these as props and re-render
  // on any identity change. The underlying props are stable refs for
  // the mount's lifetime in the app's usage.
  const onResumeRow = useMemo(() => resumeByHandle(onResume), [onResume]);
  const onForkRow = useMemo(() => forkByHandle(onFork), [onFork]);
  return (
    <div className="browser">
      <h2 className="history__title">Sessions</h2>
      <div className="browser__bar">
        <input
          className="browser__search"
          value={api.query}
          placeholder="Search all sessions — content, titles"
          onChange={(e) => api.search(e.target.value)}
        />
        <span className="browser__meta">
          {(api.firstPagePending || (api.scanning && (api.workspace.hits.length > 0 || api.other.hits.length > 0))) && (
            // One slot, one message — two at once would be porridge. The
            // SEARCH pending wins over the ambient indexing note: it
            // answers what the user just did (typed and is waiting on
            // THEIR results), while indexing is background state that
            // outlives the wait. Inside the field, so neither shifts
            // layout nor duplicates the empty-list placeholder.
            <span className={api.firstPagePending ? "browser__searching" : "browser__scanning"}>
              {api.firstPagePending ? "Searching…" : "Indexing…"}
            </span>
          )}
          {composed.listCount.total > 0 && (
            // The search field's counter — the count of THIS LIST (both
            // its tracks, journal rows in the denominator, loaded twins
            // out of it): numerator what the list DRAWS across both
            // tracks, denominator what it can draw. The
            // bare-total-vs-"X of N" choice is the composition's OWN
            // truth — shown === total exactly when the drawn population
            // has reached its bound; the engine's raw hasMore stays
            // with the engine. The show condition is total > 0, NOT
            // shown > 0: a fully-twin first page (shown 0, total N) is
            // reachable and "0 of N" there is more honest than a hidden
            // counter. On refresh/retype the old rows deliberately stay
            // until the new page zero lands — the aggregate then
            // describes the DRAWN OLD snapshot, not the freshness of
            // the new ask; inherited from the old top counter, wider
            // with the aggregate, and not promised otherwise.
            <span className="browser__count">
              {composed.listCount.shown === composed.listCount.total
                ? `${composed.listCount.total}`
                : `${composed.listCount.shown} of ${composed.listCount.total}`}
            </span>
          )}
        </span>
      </div>
      <ul
        className="history__list browser__list"
        ref={listRef}
        onScroll={onListScroll}
        // The virtual window's SPACER is the list itself: its height is
        // the measured sum, and the window's rows sit absolutely
        // positioned inside it — the list stays ONE list (ul/li), the
        // keys stay agent:sessionId, the scroll container is the list.
        // The tail (spinner/error/empty) renders AFTER the spacer, in
        // normal flow, outside the virtual count.
        style={
          emptyList
            ? undefined
            : {
                height: `${rowVirtualizer.getTotalSize()}px`,
                position: "relative",
              }
        }
      >
        {virtualItems.map((virtualRow) => {
          const row = queue[virtualRow.index];
          return (
            <SessionRowView
              key={virtualRow.key}
              row={row}
              agents={agents}
              dirMissing={row.cwd !== "" && !dirPresent(presence, row.cwd)}
              readFailed={row.readLinks.some((link) => readFailed.has(link))}
              now={now}
              onOpen={openRow}
              onResume={onResumeRow}
              onFork={onForkRow}
              virtualStart={virtualRow.start}
            />
          );
        })}
        {/* The list's TAIL — the list's basement, OUTSIDE the virtual
         * count: ONE spinner as the list's LAST element while ANY track
         * loads more, ONE error line for whichever track refused (both
         * refused — still one line). Not being data rows, these never
         * enter the virtual range's arithmetic — the thresholds count
         * DATA rows only, or "total − 1 − last visible" could go
         * negative and mask a broken threshold behind a green test. A
         * failed page zero cleared its rows on purpose — naming the
         * failure beats a truthless "No sessions match". NOT inside the
         * empty-state gate: that gate also requires the journal to be
         * empty, and a workspace with journal rows would otherwise show
         * a failed search as a quietly shorter list.
         *
         * The KNOWN, CHOSEN cost: while the WORKSPACE track loads more,
         * the spinner sits BELOW the already-drawn other rows — far
         * from where the new rows will arrive, often outside the
         * viewport. That is deliberate: the list has ONE tail, like any
         * paged list; an insertion point in a flat list is not a
         * visible address, and we promise none. Do not "fix" this back
         * into a mid-list marker — the user chose the single tail. */}
        {(api.workspace.loadingMore || api.other.loadingMore) && (
          <li
            className="history__row browser__more"
            aria-label="Loading more sessions"
          >
            <span className="browser__spinner" />
          </li>
        )}
        {(api.workspace.error || api.other.error) && (
          <li className="history__row browser__empty">
            Search failed: {(api.workspace.error ?? api.other.error)}
          </li>
        )}
        {emptyList && !api.workspace.error && !api.other.error && (
          <li className="history__row browser__empty">
            {api.scanning
              ? "Indexing the stores…"
              : api.query.trim() !== "" || rows.length > 0
                ? "No sessions match"
                : 'No sessions yet — add an agent with "+ Agent"'}
          </li>
        )}
      </ul>

      {open && (
        <div className="browser__viewer" role="dialog" aria-label="Session transcript">
          {/* A BAR, not one button: the git plugin's drill-back idiom on
           * the left (chevron + label, its own button, same clip and
           * tooltips as before — backing out of a drill-in is
           * navigation), the row's OWN actions on the right. Same
           * availability rules as the list row, read from the same
           * place — a button inside a button is not an option. */}
          <div className="browser__viewerbar">
            <button
              type="button"
              className="browser__back"
              onClick={closeViewer}
              title="Back to the sessions list"
              aria-label="Back to the sessions list"
            >
              <BackIcon />
              <span className="browser__backlabel">
                {open.title ?? open.sessionId}
              </span>
            </button>
            <SessionRowActions
              row={open.row}
              agents={agents}
              dirMissing={
                open.row.cwd !== "" && !dirPresent(presence, open.row.cwd)
              }
              onResume={onResumeRow}
              onFork={onForkRow}
            />
          </div>
          <div
            className="browser__viewer-body"
            ref={viewerRef}
            onScroll={maybeLoadPage}
          >
            {entries.map((entry, index) => (
              <div
                key={index}
                className={`browser__turn browser__turn--${entry.role}`}
              >
                {entry.text}
              </div>
            ))}
            {viewerError !== null && entries.length === 0 && (
              // The read fell — named where it happened, never disguised
              // as an empty transcript.
              <div className="browser__empty">Read failed: {viewerError}</div>
            )}
            {entries.length === 0 && viewerError === null && !loadingPage && (
              // A legitimately empty transcript (all lines were noise) must
              // not read as a hang.
              <div className="browser__empty">No transcript content</div>
            )}
            {loadingPage && (
              <div className="browser__more" aria-label="Loading transcript">
                <span className="browser__spinner" />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The row view hands back the whole row; the browser's callbacks take the
 * handle. The adapters are STABLE for the mount (useCallback below): a
 * fresh adapter per row per render would re-render every row for
 * nothing — the rows receive these as props. */
function resumeByHandle(
  onResume: (record: SessionHandle) => void,
): (row: UnifiedSessionRow) => void {
  return (row) => onResume(row.handle);
}

function forkByHandle(
  onFork: (record: SessionHandle) => void,
): (row: UnifiedSessionRow) => void {
  return (row) => onFork(row.handle);
}
