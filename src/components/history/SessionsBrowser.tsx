import { useCallback, useEffect, useRef, useState } from "react";
import { dirPresent, useDirPresence } from "./useDirPresence";
import type { AgentTranscriptEntry } from "@keepdeck/plugin-api";
import type { AgentInfo } from "../../domain/agents";
import {
  composeSessionBlocks,
  handleFromHit,
  rowKeyOf,
  rowOfHit,
  type SessionHandle,
  type SessionRecord,
  type UnifiedSessionRow,
} from "../../domain/journal";
import type { SessionsBrowserApi } from "../../app/useSessionsBrowser";
import { useSessionsBrowser, type BrowserSharedSeam } from "../../app/useSessionsBrowser";
import { BackIcon } from "../../ui/icons";
import { useScrollPaging, NEAR_END } from "../../ui/useScrollPaging";
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

/** Transcript paging mirrors the list ([F8] virtualized viewer): a viewport
 * fill first, then small increments as scrolling nears the bottom. */
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
  // Resume needs a live original directory — same gate for both blocks.
  const presence = useDirPresence([
    ...rows.map((row) => row.cwd),
    ...api.top.hits.map((hit) => hit.cwd),
    ...api.bottom.hits.map((hit) => hit.cwd),
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

  // Lazy paging, scroll-driven, for BOTH blocks: the global block pages
  // when the list nears its end (the shared engine also feeds the spawn
  // dialog's picker); the workspace block pages when its LAST row nears
  // the viewport's bottom — the divider may sit far above the list's end
  // once the global block has loaded pages of its own.
  const listRef = useRef<HTMLUListElement | null>(null);
  const maybeLoadHits = useScrollPaging(listRef, api.bottom, api.bottom.hits.length);
  const lastTopRef = useRef<HTMLLIElement | null>(null);
  const maybeLoadTop = useCallback(() => {
    const list = listRef.current;
    const last = lastTopRef.current;
    // loadMore itself guards the in-flight and exhausted states.
    if (!list || !last || !api.top.hasMore) return;
    if (last.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom < NEAR_END) {
      api.top.loadMore();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.top.hasMore, api.top.loadMore]);
  useEffect(() => {
    maybeLoadTop();
    // Re-check after each landed page, like the shared pager's count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maybeLoadTop, api.top.hits.length]);
  const onListScroll = () => {
    maybeLoadHits();
    maybeLoadTop();
  };
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

  // The transcript pages on scroll too ([F8] virtualized viewer): nearing
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
   * it for the fall-through. */
  const openRow = (row: UnifiedSessionRow) => {
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
  };

  const closeViewer = () => {
    viewSeq.current += 1;
    setOpen(null);
    setLoadingPage(false);
  };

  // The blocks' composition lives in the domain (`composeSessionBlocks`)
  // — one entry point owning the query predicate, the union, the dedup,
  // the time axis AND the counters (numerator the drawn rows,
  // denominator what the block can draw, twins out): the view feeds it
  // and draws what it returns, counters included.
  const composed = composeSessionBlocks({
    records: rows,
    query: api.query.trim(),
    entries: api.enrichment.entries,
    agentLabel: (agentId) => agents.find((a) => a.id === agentId)?.label,
    answerMayChange: api.scanning || api.enrichment.pending,
    topHits: api.top.hits.map(rowOfHit),
    bottomHits: api.bottom.hits.map(rowOfHit),
    topTotal: api.top.total,
    bottomTotal: api.bottom.total,
  });
  const topRows = composed.top.rows;
  const bottomRows = composed.bottom.rows;
  const emptyList = topRows.length === 0 && bottomRows.length === 0;

  const now = Date.now();
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
          {(api.firstPagePending || (api.scanning && (api.top.hits.length > 0 || api.bottom.hits.length > 0))) && (
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
          {composed.overall.total > 0 && (
            // The search field's counter — the AGGREGATE of both blocks
            // (journal rows in the denominator, loaded twins out of it):
            // numerator what the field's results DRAW across both
            // blocks, denominator what they can draw. The
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
            // with the aggregate, and not promised otherwise. The
            // divider's own condition (topRows.length > 0) is
            // DELIBERATELY different: silence over an empty top half is
            // right — there is nothing to divide.
            <span className="browser__count">
              {composed.overall.shown === composed.overall.total
                ? `${composed.overall.total}`
                : `${composed.overall.shown} of ${composed.overall.total}`}
            </span>
          )}
        </span>
      </div>
      <ul
        className="history__list browser__list"
        ref={listRef}
        onScroll={onListScroll}
      >
        {topRows.map((row, at) => (
          <SessionRowView
            key={rowKeyOf(row)}
            row={row}
            agents={agents}
            dirMissing={row.cwd !== "" && !dirPresent(presence, row.cwd)}
            readFailed={row.readLinks.some((link) => readFailed.has(link))}
            now={now}
            onOpen={openRow}
            onResume={onResumeByHandle(onResume)}
            onFork={onForkByHandle(onFork)}
            // The workspace block's own paging anchor: its LAST row.
            rowRef={at === topRows.length - 1 ? lastTopRef : undefined}
          />
        ))}
        {api.top.loadingMore && (
          <li
            className="history__row browser__more"
            aria-label="Loading more workspace sessions"
          >
            <span className="browser__spinner" />
          </li>
        )}
        {topRows.length > 0 &&
          (bottomRows.length > 0 || composed.bottom.total > 0) && (
            <li className="browser__section">
              All sessions
              {composed.bottom.total > 0 && (
                <span className="browser__section-count">
                  {composed.bottom.shown === composed.bottom.total
                    ? ` · ${composed.bottom.total}`
                    : ` · ${composed.bottom.shown} of ${composed.bottom.total}`}
                </span>
              )}
            </li>
          )}
        {bottomRows.map((row) => (
          <SessionRowView
            key={rowKeyOf(row)}
            row={row}
            agents={agents}
            dirMissing={row.cwd !== "" && !dirPresent(presence, row.cwd)}
            readFailed={row.readLinks.some((link) => readFailed.has(link))}
            now={now}
            onOpen={openRow}
            onResume={onResumeByHandle(onResume)}
            onFork={onForkByHandle(onFork)}
          />
        ))}
        {api.bottom.loadingMore && (
          <li className="history__row browser__more" aria-label="Loading more sessions">
            <span className="browser__spinner" />
          </li>
        )}
        {/* A failed page zero cleared its rows on purpose — naming the
            failure beats a truthless "No sessions match". NOT inside the
            empty-state gate: that gate also requires the journal to be
            empty, and a workspace with journal rows would otherwise show a
            failed search as a quietly shorter list. */}
        {api.top.error && (
          <li className="history__row browser__empty">
            Workspace search failed: {api.top.error}
          </li>
        )}
        {api.bottom.error && (
          <li className="history__row browser__empty">
            Search failed: {api.bottom.error}
          </li>
        )}
        {emptyList && !api.top.error && !api.bottom.error && (
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
              onResume={onResumeByHandle(onResume)}
              onFork={onForkByHandle(onFork)}
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
 * handle — one adapter, defined once, not per row. */
function onResumeByHandle(
  onResume: (record: SessionHandle) => void,
): (row: UnifiedSessionRow) => void {
  return (row) => onResume(row.handle);
}

function onForkByHandle(
  onFork: (record: SessionHandle) => void,
): (row: UnifiedSessionRow) => void {
  return (row) => onFork(row.handle);
}
