import { useCallback, useEffect, useRef, useState } from "react";
import { dirPresent, useDirPresence } from "./useDirPresence";
import type { AgentTranscriptEntry } from "@keepdeck/plugin-api";
import type { AgentInfo } from "../../domain/agents";
import {
  handleFromHit,
  joinJournalRow,
  rowOfHit,
  rowOfJoined,
  type SessionHandle,
  type SessionRecord,
  type UnifiedSessionRow,
} from "../../domain/journal";
import type { SessionsBrowserApi } from "../../app/useSessionsBrowser";
import { rowKeyOf } from "../../app/useJournalEnrichment";
import { BackIcon } from "../../ui/icons";
import { useScrollPaging, NEAR_END } from "../../ui/useScrollPaging";
import { SessionRowView } from "./SessionRowView";

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

/** The domain's hit→handle mapping under this file's historical name (the
 * spawn dialog's picker shares the same mapping via the domain export). */
export const hitRecord = handleFromHit;

/** Transcript paging mirrors the list ([F8] virtualized viewer): a viewport
 * fill first, then small increments as scrolling nears the bottom. */
const FIRST_TURNS = 50;
const NEXT_TURNS = 20;

/** What the transcript viewer reads — one row's read link, whichever list
 * the row came from (a journal row or an index hit). */
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
  /** Rows whose LAST read by link fell (the file vanished between scans).
   * The row stays and stays openable — a retry is legitimate — but the
   * failure is named on the row, as itself and never as "nothing to
   * read". */
  const [readFailed, setReadFailed] = useState<ReadonlySet<string>>(new Set());
  // Resume needs a live original directory — same gate for both blocks.
  const presence = useDirPresence([
    ...rows.map((row) => row.cwd),
    ...api.hits.map((hit) => hit.cwd),
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

  // Lazy paging of the hits list, scroll-driven (the shared engine also feeds
  // the spawn dialog's picker).
  const listRef = useRef<HTMLUListElement | null>(null);
  const maybeLoadHits = useScrollPaging(listRef, api, api.hits.length);
  const nearEnd = (el: HTMLElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END;

  /** One transcript read of `target` at `from`. A page-zero refusal falls
   * through to the row's NEXT read link (the union is a real fallback, not
   * a display priority): the journal path is a record of the past, the
   * index link reflects the last scan — a moved file can leave the second
   * live. The failure mark lands only when the LAST link refused too. */
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
        // The read fell on the LAST link — typically the transcript file
        // vanished between the scan that indexed it and this open. Named
        // as itself, on the viewer AND on the row; the row keeps its
        // place. The mark is the ROW's verdict, so it lands on every link
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
    });
  };

  const closeViewer = () => {
    viewSeq.current += 1;
    setOpen(null);
    setLoadingPage(false);
  };

  // The journal section under an active query: the index search matches
  // CONTENT the client never sees, so the pinned section filters on what it
  // has — title, directory, branch, session id. Deliberately the JOURNAL's
  // fields, not the joined title: enrichment paints cells, it never
  // decides composition — a title arriving late must not make a filtered
  // row vanish or appear.
  const query = api.query.trim().toLowerCase();
  const journalFiltered =
    query === ""
      ? rows
      : rows.filter((row) =>
          [row.title, row.cwd, row.branch, row.sessionId].some(
            (field) => field !== undefined && field.toLowerCase().includes(query),
          ),
        );
  // The top block's unified rows — the join against the shared enrichment
  // table, then the row shape both blocks render.
  const topRows = journalFiltered.map((row) => {
    const agent = agents.find((a) => a.id === row.agent);
    return rowOfJoined(
      joinJournalRow(
        row,
        api.enrichment.entries.get(rowKeyOf(row)),
        agent?.label,
        // "The answer may still change": the scan state OR the enrichment
        // table's own pending (an ask in flight, or a revision-bumped
        // re-ask still owed) — the scan-end publish flips scanning and
        // bumps the revision in ONE re-render, before any effect can fire
        // the re-ask, so this composed flag is what keeps that boundary
        // frame honest.
        api.scanning || api.enrichment.pending,
      ),
    );
  });
  // Dedupe against the VISIBLE top rows, not the full journal: a session
  // the query hid from the pinned section (its match is content-only) must
  // still show below with its snippet, not vanish entirely.
  const pinned = new Set(topRows.map((row) => `${row.agent}:${row.sessionId}`));
  const bottomRows = api.hits
    .filter((hit) => !pinned.has(`${hit.agent}:${hit.sessionId}`))
    .map(rowOfHit);
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
          {api.scanning && api.hits.length > 0 && (
            // Inside the field, so a background rescan neither shifts layout
            // nor duplicates the empty-list placeholder.
            <span className="browser__scanning">indexing…</span>
          )}
          {api.total > 0 && (
            <span className="browser__count">
              {api.hasMore
                ? `${api.hits.length} of ${api.total}`
                : `${api.total}`}
            </span>
          )}
        </span>
      </div>
      <ul
        className="history__list browser__list"
        ref={listRef}
        onScroll={maybeLoadHits}
      >
        {topRows.map((row) => (
          <SessionRowView
            key={`${row.agent}:${row.sessionId}`}
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
        {topRows.length > 0 && bottomRows.length > 0 && (
          <li className="browser__section">All sessions</li>
        )}
        {bottomRows.map((row) => (
          <SessionRowView
            key={`${row.agent}:${row.sessionId}`}
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
        {api.loadingMore && (
          <li className="history__row browser__more" aria-label="Loading more sessions">
            <span className="browser__spinner" />
          </li>
        )}
        {/* A failed page zero cleared its rows on purpose — naming the
            failure beats a truthless "No sessions match". NOT inside the
            empty-state gate: that gate also requires the journal to be
            empty, and a workspace with journal rows would otherwise show a
            failed search as a quietly shorter list. */}
        {api.error && (
          <li className="history__row browser__empty">
            Search failed: {api.error}
          </li>
        )}
        {emptyList && !api.error && (
          <li className="history__row browser__empty">
            {api.scanning
              ? "Indexing the stores…"
              : query !== "" || rows.length > 0
                ? "No sessions match"
                : 'No sessions yet — add an agent with "+ Agent"'}
          </li>
        )}
      </ul>

      {open && (
        <div className="browser__viewer" role="dialog" aria-label="Session transcript">
          <button
            type="button"
            // The git plugin's drill-back idiom, verbatim: a full-width row
            // at the top, left chevron + the drilled-into label — backing
            // out of a drill-in is navigation, not a window close.
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
