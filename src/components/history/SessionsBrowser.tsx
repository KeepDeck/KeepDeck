import { useCallback, useEffect, useRef, useState } from "react";
import { dirPresent, useDirPresence } from "./useDirPresence";
import type { AgentTranscriptEntry } from "@keepdeck/plugin-api";
import type { AgentInfo } from "../../domain/agents";
import type { SessionHandle } from "../../domain/journal";
import { formatAge } from "../../domain/usage/format";
import type { SearchHit } from "../../ipc/history";
import type { SessionsBrowserApi } from "../../app/useSessionsBrowser";
import { AgentGlyph } from "../../ui/AgentGlyph";
import { baseName } from "../../domain/deck";

interface SessionsBrowserProps {
  api: SessionsBrowserApi;
  agents: AgentInfo[];
  /** The agent plugins finished activating — before that a scan would see
   * an empty registry and "successfully" index zero stores. */
  ready: boolean;
  onResume(record: SessionHandle): void;
  onFork(record: SessionHandle): void;
}

/** A search hit as the SessionHandle the resume/fork flows consume — no
 * fabricated journal lifecycle fields. The transcript path comes from the
 * index EXPLICITLY (the plugin's `describe` declared it) — the ref stays
 * the opaque handle it claims to be. */
export function hitRecord(hit: SearchHit): SessionHandle {
  return {
    agent: hit.agent,
    sessionId: hit.sessionId,
    cwd: hit.cwd,
    ...(hit.title !== null && { title: hit.title }),
    ...(hit.transcriptPath !== null && { transcriptPath: hit.transcriptPath }),
  };
}

const PAGE = 100;

/**
 * The global sessions browser ([F8]): every session of every agent store,
 * searchable by content and title. Search hits only the Rust index; opening
 * a row reads the transcript live through the owning plugin. Resume runs in
 * the session's ORIGINAL directory; Fork picks a new home.
 */
export function SessionsBrowser({ api, agents, ready, onResume, onFork }: SessionsBrowserProps) {
  const [open, setOpen] = useState<SearchHit | null>(null);
  const [entries, setEntries] = useState<AgentTranscriptEntry[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loadingPage, setLoadingPage] = useState(false);
  // Resume needs a live original directory — same gate the journal rows use.
  const presence = useDirPresence(api.hits.map((hit) => hit.cwd));
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

  // Lazy paging of the hits list, scroll-driven: nearing the end pulls the
  // next page in. The same check runs after every landed page so a viewport
  // taller than the loaded rows (no scrollbar yet) still fills up.
  const listRef = useRef<HTMLUListElement | null>(null);
  const { hasMore, loadMore: loadMoreHits, hits } = api;
  const nearEnd = (el: HTMLElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight < 240;
  const maybeLoadHits = useCallback(() => {
    const list = listRef.current;
    // loadMore itself guards in-flight and exhausted states.
    if (list && nearEnd(list)) loadMoreHits();
  }, [loadMoreHits]);
  useEffect(() => {
    if (hasMore) maybeLoadHits();
  }, [hasMore, maybeLoadHits, hits.length]);

  const loadMore = (hit: SearchHit, from: number) => {
    const seq = viewSeq.current;
    setLoadingPage(true);
    void api
      .transcript(hit.agent, hit.reference, from, PAGE)
      .then((page) => {
        if (viewSeq.current !== seq) return; // another row opened meanwhile
        setEntries((current) => (from === 0 ? page : [...current, ...page]));
        setExhausted(page.length < PAGE);
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

  const now = Date.now();
  return (
    <div className="browser">
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
        {api.hits.map((hit) => {
          const agent = agents.find((a) => a.id === hit.agent);
          return (
            <li key={`${hit.agent}:${hit.sessionId}`} className="history__row">
              <span className="history__glyph">
                <AgentGlyph icon={agent?.icon} />
              </span>
              <button
                type="button"
                className="browser__open"
                title="Read this session"
                onClick={() => openViewer(hit)}
              >
                <span className="browser__name">
                  {hit.title ?? hit.sessionId}
                </span>
                {hit.snippet !== null && (
                  <span className="browser__snippet">{hit.snippet}</span>
                )}
              </button>
              <span className="history__chip" title={hit.cwd}>
                {baseName(hit.cwd) || hit.cwd}
              </span>
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
                onClick={() => onResume(hitRecord(hit))}
              >
                Resume
              </button>
              <button
                type="button"
                className="history__fork"
                title="Fork — a new conversation continuing from this session"
                onClick={() => onFork(hitRecord(hit))}
              >
                Fork…
              </button>
            </li>
          );
        })}
        {api.loadingMore && (
          <li className="history__row browser__more">Loading…</li>
        )}
        {api.hits.length === 0 && (
          <li className="history__row browser__empty">
            {api.scanning ? "Indexing the stores…" : "No sessions match"}
          </li>
        )}
      </ul>

      {open && (
        <div className="browser__viewer" role="dialog" aria-label="Session transcript">
          <div className="browser__viewer-head">
            <span className="browser__name">{open.title ?? open.sessionId}</span>
            <button
              type="button"
              className="history__delete"
              aria-label="Close transcript"
              onClick={closeViewer}
            >
              ×
            </button>
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
            {entries.length === 0 && (
              // A legitimately empty transcript (all lines were noise) must
              // not read as a hang.
              <div className="browser__empty">
                {loadingPage ? "Loading…" : "No transcript content"}
              </div>
            )}
            {loadingPage && entries.length > 0 && (
              <div className="browser__more">Loading…</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
