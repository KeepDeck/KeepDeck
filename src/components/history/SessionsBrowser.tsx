import { useCallback, useEffect, useRef, useState } from "react";
import { dirPresent, useDirPresence } from "./useDirPresence";
import type { AgentTranscriptEntry } from "@keepdeck/plugin-api";
import {
  agentSessionCapabilities,
  type AgentInfo,
} from "../../domain/agents";
import {
  handleFromHit,
  joinJournalRow,
  type JoinedRow,
  type RowStatus,
  type SessionHandle,
  type SessionRecord,
} from "../../domain/journal";
import { formatAge } from "../../domain/usage/format";
import type { SessionsBrowserApi } from "../../app/useSessionsBrowser";
import { rowKeyOf } from "../../app/useJournalEnrichment";
import { AgentGlyph } from "../../ui/AgentGlyph";
import { BackIcon } from "../../ui/icons";
import { Chip } from "../../ui/Chip";
import { useScrollPaging, NEAR_END } from "../../ui/useScrollPaging";
import { baseName } from "../../domain/deck";

interface SessionsBrowserProps {
  api: SessionsBrowserApi;
  agents: AgentInfo[];
  /** The workspace's journal, newest binding first (`journalRows`). */
  rows: SessionRecord[];
  /** The agent plugins finished activating — before that a scan would see
   * an empty registry and "successfully" index zero stores. */
  ready: boolean;
  /** Forget one journal record — journal metadata only, the agent store is
   * untouched. */
  onDelete(sessionId: string): void;
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
}

/** The journal row's status chip — the visible stand-in for everything
 * that keeps a row unopenable. Plain rows carry no chip at all. */
const STATUS_CHIP: Record<
  RowStatus,
  { label: string; title: string; tone?: "error" }
> = {
  "wrong-owner": {
    label: "wrong agent",
    tone: "error",
    title:
      "This session id exists under another agent — the journal recorded the wrong one, so the row cannot be opened or continued here",
  },
  indexing: {
    label: "indexing…",
    title:
      "The session index is still filling — the row's readability is decided when it answers",
  },
  "nothing-to-read": {
    label: "nothing to read",
    title:
      "The conversation ran here, but no transcript survives in the journal or the index",
  },
  "index-error": {
    label: "index unreachable",
    tone: "error",
    title:
      "The index could not be asked — not a verdict on the session; what was already known still stands",
  },
};

/**
 * The empty-workspace sessions surface ([F8]): ONE list with the search bar
 * on top. The workspace's own journal pins first — the sessions that ran here,
 * with their lifecycle affordances (live/closed dot, branch, forget). Below a
 * divider, every other session of every agent store, searchable by content
 * and title. Search hits only the Rust index; opening a hit row reads the
 * transcript live through the owning plugin (a journal row has no store
 * reference, so it stays non-clickable). Resume runs in the session's
 * ORIGINAL directory; Fork picks a new home.
 */
export function SessionsBrowser({
  api,
  agents,
  rows,
  ready,
  onDelete,
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
  // Resume needs a live original directory — same gate for both sections.
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
        // A good page retires the row's failure mark — the link reads.
        setReadFailed((current) => {
          if (!current.has(target.reference)) return current;
          const next = new Set(current);
          next.delete(target.reference);
          return next;
        });
      })
      .catch((e: unknown) => {
        if (viewSeq.current !== seq) return;
        // The read itself fell — typically the transcript file vanished
        // between the scan that indexed it and this open. Named as itself,
        // on the viewer AND on the row; the row keeps its place. Exhausted
        // stops the viewer's fill-the-viewport effect from re-requesting a
        // link that just refused — a retry comes from a fresh open.
        setViewerError(e instanceof Error ? e.message : String(e));
        setExhausted(true);
        setReadFailed((current) => new Set(current).add(target.reference));
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

  /** A journal row opens on its JOINED read link — the journal's own
   * transcript path first, the index's reference in its absence. */
  const openJournal = (joined: JoinedRow) => {
    if (joined.read === null) return;
    openViewer({
      agent: joined.record.agent,
      sessionId: joined.record.sessionId,
      reference: joined.read.reference,
      title: joined.title ?? null,
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
  const journalRows =
    query === ""
      ? rows
      : rows.filter((row) =>
          [row.title, row.cwd, row.branch, row.sessionId].some(
            (field) => field !== undefined && field.toLowerCase().includes(query),
          ),
        );
  // Dedupe against the VISIBLE journal rows, not the full journal: a session
  // the query hid from the pinned section (its match is content-only) must
  // still show below with its snippet, not vanish entirely.
  const pinned = new Set(journalRows.map((row) => `${row.agent}:${row.sessionId}`));
  const hits = api.hits.filter((hit) => !pinned.has(`${hit.agent}:${hit.sessionId}`));
  const emptyList = journalRows.length === 0 && hits.length === 0;

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
        {journalRows.map((row) => {
          const agent = agents.find((a) => a.id === row.agent);
          const {
            resume: supportsResume,
            fork: supportsFork,
            history: canReadHistory,
          } = agentSessionCapabilities(agents, row.agent);
          const joined = joinJournalRow(
            row,
            api.enrichment.entries.get(rowKeyOf(row)),
            agent?.label,
            // "The answer may still change": the scan state OR the
            // enrichment table's own pending (an ask in flight, or a
            // revision-bumped re-ask still owed) — the scan-end publish
            // flips scanning and bumps the revision in ONE re-render,
            // before any effect can fire the re-ask, so this composed
            // flag is what keeps that boundary frame honest.
            api.scanning || api.enrichment.pending,
          );
          const openable = joined.read !== null && canReadHistory;
          // A wrong-owner row is visible but continuation would feed the
          // wrong plugin — the affordances do not render at all.
          const wrongOwner = joined.status === "wrong-owner";
          const name = joined.title ?? agent?.label ?? row.agent;
          const when = row.state === "closed" ? row.endedAt : row.boundAt;
          const dirMissing = !dirPresent(presence, row.cwd);
          const statusChip = joined.status === null ? null : STATUS_CHIP[joined.status];
          return (
            <li
              key={`${row.agent}:${row.sessionId}`}
              className={`history__row browser__journal${
                openable ? " browser__journal--open" : ""
              }`}
              onClick={openable ? () => openJournal(joined) : undefined}
            >
              <span
                className={`history__state${
                  row.state === "live" ? " history__state--live" : ""
                }`}
                title={row.state === "live" ? "Running" : "Closed"}
              />
              <span className="history__glyph">
                <AgentGlyph icon={agent?.icon} />
              </span>
              {openable ? (
                // The name is the row's open button — same hit-target
                // shape as the hits below, keyboard-reachable.
                <button
                  type="button"
                  className="history__name history__name--open"
                  title="Read this session"
                  onClick={(e) => {
                    e.stopPropagation();
                    openJournal(joined);
                  }}
                >
                  {name}
                </button>
              ) : (
                <span className="history__name" title={row.sessionId}>
                  {name}
                </span>
              )}
              {row.branch !== undefined && (
                <Chip
                  size="inline"
                  className="history__chip"
                  title={row.cwd}
                  label={row.branch}
                />
              )}
              <span className="history__when">
                {formatAge(Date.parse(when), now)}
              </span>
              {dirMissing && (
                <Chip
                  size="inline"
                  tone="error"
                  className="history__missing"
                  title={`${row.cwd} no longer exists — the session cannot resume in place`}
                  label="dir gone"
                />
              )}
              {statusChip !== null && (
                <Chip
                  size="inline"
                  tone={statusChip.tone}
                  className="history__status"
                  title={statusChip.title}
                  label={statusChip.label}
                />
              )}
              {joined.read !== null && readFailed.has(joined.read.reference) && (
                <Chip
                  size="inline"
                  tone="error"
                  className="history__status"
                  title="Reading this session failed — its transcript file disappeared between the scan and the open. This is not 'nothing to read': the row stays, and a retry is legitimate."
                  label="read failed"
                />
              )}
              {row.state === "closed" && supportsResume && !wrongOwner && (
                <button
                  type="button"
                  className="history__resume"
                  disabled={dirMissing}
                  title={
                    dirMissing
                      ? "The session's directory no longer exists"
                      : "Resume this session in a new pane"
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    onResume(row);
                  }}
                >
                  Resume
                </button>
              )}
              {supportsFork && !wrongOwner && (
                <button
                  type="button"
                  className="history__fork"
                  title="Fork — a new conversation continuing from this session"
                  onClick={(e) => {
                    e.stopPropagation();
                    onFork(row);
                  }}
                >
                  Fork
                </button>
              )}
              <button
                type="button"
                className="history__delete"
                aria-label="Forget session"
                title="Forget this session"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(row.sessionId);
                }}
              >
                ×
              </button>
            </li>
          );
        })}
        {journalRows.length > 0 && hits.length > 0 && (
          <li className="browser__section">All sessions</li>
        )}
        {hits.map((hit) => {
          const agent = agents.find((a) => a.id === hit.agent);
          const {
            history: canReadHistory,
            resume: supportsResume,
            fork: supportsFork,
          } = agentSessionCapabilities(agents, hit.agent);
          return (
            <li
              key={`${hit.agent}:${hit.sessionId}`}
              className="history__row"
              // The WHOLE row opens the transcript — aiming at the text
              // alone is a hidden hit-target. The action buttons stop the
              // bubble; the inner button stays for keyboard access (its
              // synthesized click bubbles here too).
              onClick={
                canReadHistory
                  ? () =>
                      openViewer({
                        agent: hit.agent,
                        sessionId: hit.sessionId,
                        reference: hit.reference,
                        title: hit.title,
                      })
                  : undefined
              }
            >
              <span className="history__glyph">
                <AgentGlyph icon={agent?.icon} />
              </span>
              <button
                type="button"
                className="browser__open"
                disabled={!canReadHistory}
                title={
                  canReadHistory
                    ? "Read this session"
                    : "Session history is unavailable for this agent"
                }
              >
                <span className="browser__name">
                  {hit.title ?? hit.sessionId}
                </span>
                {hit.snippet !== null && (
                  <span className="browser__snippet">{hit.snippet}</span>
                )}
              </button>
              {hit.cwd !== "" && (
                // No chip at all for a cwd-less session — an empty pill
                // renders as a stray outline sliver.
                <Chip
                  size="inline"
                  className="history__chip"
                  title={hit.cwd}
                  label={baseName(hit.cwd) || hit.cwd}
                />
              )}
              <span className="history__when">{formatAge(hit.mtime, now)}</span>
              {supportsResume && (
                <button
                  type="button"
                  className="history__resume"
                  disabled={!dirPresent(presence, hit.cwd)}
                  title={
                    hit.cwd === ""
                      ? "The session has no recorded directory"
                      : dirPresent(presence, hit.cwd)
                        ? `Resume in ${hit.cwd}`
                        : "The session's directory no longer exists — fork it instead"
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    onResume(hitRecord(hit));
                  }}
                >
                  Resume
                </button>
              )}
              {supportsFork && (
                <button
                  type="button"
                  className="history__fork"
                  title="Fork — a new conversation continuing from this session"
                  onClick={(e) => {
                    e.stopPropagation();
                    onFork(hitRecord(hit));
                  }}
                >
                  Fork
                </button>
              )}
            </li>
          );
        })}
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
