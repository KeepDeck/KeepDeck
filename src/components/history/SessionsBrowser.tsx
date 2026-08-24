import { useEffect, useMemo, useRef } from "react";
import { dirPresent, useDirPresence } from "./useDirPresence";
import type { AgentInfo } from "../../domain/agents";
import {
  handleFromHit,
  type SessionHandle,
  type SessionRecord,
  type UnifiedSessionRow,
} from "../../domain/journal";
import type { SessionsBrowserApi } from "../../app/useSessionsBrowser";
import { useSessionsBrowser, type BrowserSharedSeam } from "../../app/useSessionsBrowser";
import { SessionRowView } from "./SessionRowView";
import { SessionViewer } from "./browser/SessionViewer";
import { useSessionListComposition } from "./browser/useSessionListComposition";
import { BrowserSearchStatus } from "./browser/BrowserSearchStatus";
import { useBrowserClock } from "./browser/useBrowserClock";
import { useSessionOpening } from "./browser/useSessionOpening";
import { useSessionListWindow } from "./browser/useSessionListWindow";

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
  const { workspaceRows, otherRows, listCount, emptyList } =
    useSessionListComposition({ api, agents, rows });

  const queue = useMemo(
    () => [...workspaceRows, ...otherRows],
    [workspaceRows, otherRows],
  );
  const { virtualItems, totalSize, measureRow, onListScroll } =
    useSessionListWindow({
      listRef,
      queue,
      workspaceRowCount: workspaceRows.length,
      workspace: api.workspace,
      other: api.other,
    });

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
                height: `${totalSize}px`,
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
