import { useCallback, useEffect, useRef, useState } from "react";
import { dirPresent, useDirPresence } from "./useDirPresence";
import type { AgentTranscriptEntry } from "@keepdeck/plugin-api";
import type { AgentInfo } from "../../domain/agents";
import {
  handleFromHit,
  type SessionHandle,
  type SessionRecord,
} from "../../domain/journal";
import { formatAge } from "../../domain/usage/format";
import type { SearchHit } from "../../ipc/history";
import type { SessionsBrowserApi } from "../../app/useSessionsBrowser";
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
  const [open, setOpen] = useState<SearchHit | null>(null);
  const [entries, setEntries] = useState<AgentTranscriptEntry[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loadingPage, setLoadingPage] = useState(false);
  // Resume needs a live original directory — same gate for both sections.
  const presence = useDirPresence([
    ...rows.map((row) => row.cwd),
    ...api.hits.map((hit) => hit.cwd),
  ]);
  // Orders transcript responses: a stale page must never render under a
  // newer row's header (the search path has searchSeq; this is its twin).
  const viewSeq = useRef(0);

  // The scan waits for plugin activation (the registry is empty until
  // then), re-firing when readiness lands; the listing itself is the hook's
  // job — it ran the initial search once, and a second browser mount must
  // not reset a query another instance is showing.
  useEffect(() => {
    if (ready) api.scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Lazy paging of the hits list, scroll-driven (the shared engine also feeds
  // the spawn dialog's picker).
  const listRef = useRef<HTMLUListElement | null>(null);
  const maybeLoadHits = useScrollPaging(listRef, api, api.hits.length);
  const nearEnd = (el: HTMLElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END;

  const loadMore = (hit: SearchHit, from: number) => {
    const seq = viewSeq.current;
    const limit = from === 0 ? FIRST_TURNS : NEXT_TURNS;
    setLoadingPage(true);
    void api
      .transcript(hit.agent, hit.reference, from, limit)
      .then((page) => {
        if (viewSeq.current !== seq) return; // another row opened meanwhile
        setEntries((current) => (from === 0 ? page : [...current, ...page]));
        setExhausted(page.length < limit);
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

  const openViewer = (hit: SearchHit) => {
    viewSeq.current += 1;
    setOpen(hit);
    setEntries([]);
    setExhausted(false);
    setLoadingPage(false);
    loadMore(hit, 0);
  };

  const closeViewer = () => {
    viewSeq.current += 1;
    setOpen(null);
    setLoadingPage(false);
  };

  // The journal section under an active query: the index search matches
  // CONTENT the client never sees, so the pinned section filters on what it
  // has — title, directory, branch, session id.
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
          const when = row.state === "closed" ? row.endedAt : row.boundAt;
          const dirMissing = !dirPresent(presence, row.cwd);
          return (
            <li
              key={`${row.agent}:${row.sessionId}`}
              className="history__row browser__journal"
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
              <span className="history__name" title={row.sessionId}>
                {row.title ?? agent?.label ?? row.agent}
              </span>
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
              {row.state === "closed" && (
                <button
                  type="button"
                  className="history__resume"
                  disabled={dirMissing}
                  title={
                    dirMissing
                      ? "The session's directory no longer exists"
                      : "Resume this session in a new pane"
                  }
                  onClick={() => onResume(row)}
                >
                  Resume
                </button>
              )}
              <button
                type="button"
                className="history__fork"
                title="Fork — a new conversation continuing from this session"
                onClick={() => onFork(row)}
              >
                Fork
              </button>
              <button
                type="button"
                className="history__delete"
                aria-label="Forget session"
                title="Forget this session"
                onClick={() => onDelete(row.sessionId)}
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
          return (
            <li
              key={`${hit.agent}:${hit.sessionId}`}
              className="history__row"
              // The WHOLE row opens the transcript — aiming at the text
              // alone is a hidden hit-target. The action buttons stop the
              // bubble; the inner button stays for keyboard access (its
              // synthesized click bubbles here too).
              onClick={() => openViewer(hit)}
            >
              <span className="history__glyph">
                <AgentGlyph icon={agent?.icon} />
              </span>
              <button type="button" className="browser__open" title="Read this session">
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
            </li>
          );
        })}
        {api.loadingMore && (
          <li className="history__row browser__more" aria-label="Loading more sessions">
            <span className="browser__spinner" />
          </li>
        )}
        {emptyList && (
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
            {entries.length === 0 && !loadingPage && (
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
