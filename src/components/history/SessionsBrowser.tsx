import { useCallback, useEffect, useMemo, useRef } from "react";
import { dirPresent, useDirPresence } from "./useDirPresence";
import type { AgentInfo } from "../../domain/agents";
import {
  handleFromHit,
  rowKeyOf,
  type SessionHandle,
  type SessionRecord,
  type UnifiedSessionRow,
} from "../../domain/journal";
import type { SessionsBrowserApi } from "../../app/useSessionsBrowser";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useSessionsBrowser, type BrowserSharedSeam } from "../../app/useSessionsBrowser";
import { SessionRowView } from "./SessionRowView";
import { SessionViewer } from "./browser/SessionViewer";
import { useSessionListComposition } from "./browser/useSessionListComposition";
import { useRowAnchoring } from "./browser/useRowAnchoring";
import { BrowserSearchStatus } from "./browser/BrowserSearchStatus";
import { useBrowserClock } from "./browser/useBrowserClock";
import { useSessionOpening } from "./browser/useSessionOpening";

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

const OVERSCAN_ROWS = 6;

/**
 * The empty-workspace sessions surface ([F8]): ONE list with the search bar
 * on top. The workspace's own journal pins first — the sessions that ran
 * here — followed by every other session from every agent store. The two
 * search engines provide that order, while the queue renders one row
 * component for every source. Search hits only the Rust index;
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
  const {
    open,
    readFailed,
    setReadFailed,
    viewSeq,
    openRow,
    closeViewer,
  } = useSessionOpening();
  // Resume needs a live original directory — same gate for both
  // lanes. The cwd LIST is memoized on the real sources: the hook's
  // own fingerprint dedup keeps the effect from re-probing, but the
  // ARRAY construction itself ran on every render (the minute tick
  // included) — an unrelated state change must not even walk the
  // inputs.
  const presenceCwds = useMemo(
    () => [
      ...rows.map((row) => row.cwd),
      ...api.workspace.hits.map((hit) => hit.cwd),
      ...api.other.hits.map((hit) => hit.cwd),
    ],
    [rows, api.workspace.hits, api.other.hits],
  );
  const presence = useDirPresence(presenceCwds);
  const now = useBrowserClock();
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
  // last row of a lane unmounts by definition once scrolled past). Two
  // SEPARATE thresholds, each asking only its own engine. The
  // virtualizer and the thresholds live below the composed rows —
  // they read the stabilized queue.
  const listRef = useRef<HTMLUListElement | null>(null);
  const PAGE_AHEAD = 40;

  const { workspaceRows, otherRows, listCount, emptyList } =
    useSessionListComposition({ api, agents, rows });

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
  const maybeLoadBoth = useCallback(() => {
    if (lastVirtualIndex < 0) return;
    // The workspace lane's tail asks ONLY its own engine.
    if (api.workspace.hasMore && workspaceRows.length > 0) {
      if (workspaceRows.length - 1 - lastVirtualIndex <= PAGE_AHEAD) {
        api.workspace.loadMore();
      }
    }
    // The list's tail asks ONLY the other engine.
    if (api.other.hasMore) {
      if (queue.length - 1 - lastVirtualIndex <= PAGE_AHEAD) {
        api.other.loadMore();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    lastVirtualIndex,
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
  // construction; the first cut here focused the list on any mutation
  // with focus in body and stole focus from plain mouse scrolls —
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
    maybeLoadBoth();
  };

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
          <BrowserSearchStatus
            firstPagePending={api.firstPagePending}
            scanning={api.scanning}
            hasRows={api.workspace.hits.length > 0 || api.other.hits.length > 0}
          />
          {listCount.total > 0 && (
            // The search field's counter — the count of THIS LIST (both
            // its lanes, journal rows in the denominator, loaded twins
            // out of it): numerator what the list DRAWS across both
            // lanes, denominator what it can draw. The
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
              {listCount.shown === listCount.total
                ? `${listCount.total}`
                : `${listCount.shown} of ${listCount.total}`}
            </span>
          )}
        </span>
      </div>
      <ul
        className="history__list browser__list"
        ref={listRef}
        onScroll={onListScroll}
        // Focus landing pad: when a row holding the focus unmounts
        // (scrolled out of the virtual window), focus moves HERE — the
        // list container — not to <body>. The person notices focus by
        // its ring AND by their place in the tab walk; the container
        // KEEPS the place (the next Tab enters the nearest visible
        // row), while body would restart the walk at the page top.
        // Choosing a NEIGHBORING row was rejected as guessing intent
        // (up or down?). The overscan buffer (`OVERSCAN_ROWS` rows) covers ordinary
        // stepping; this transfer covers the fling that jumps past it.
        tabIndex={-1}
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
              virtualIndex={virtualRow.index}
              // Dynamic heights: the meta line wraps and a future
              // snippet stretches the row AFTER first paint — the row
              // reports its real box, the virtualizer re-measures, and
              // the anchor-by-key correction above keeps the watched
              // row at its offset when a size changes ABOVE it.
              measureRef={measureRow}
            />
          );
        })}
        {/* The list's TAIL — the list's basement, OUTSIDE the virtual
         * count: ONE spinner as the list's LAST element while ANY lane
         * loads more, ONE error line for whichever lane refused (both
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
         * The KNOWN, CHOSEN cost: while the WORKSPACE lane loads more,
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
        <SessionViewer
          target={open}
          api={api}
          agents={agents}
          presence={presence}
          readFailed={setReadFailed}
          viewSeq={viewSeq}
          onClose={closeViewer}
          onResume={onResumeRow}
          onFork={onForkRow}
        />
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
