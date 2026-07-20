import { useEffect, useState } from "react";
import type { AgentTranscriptEntry } from "@keepdeck/plugin-api";
import type { AgentInfo } from "../../domain/agents";
import type { SessionRecord } from "../../domain/journal";
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
  onResume(record: SessionRecord): void;
  onFork(record: SessionRecord): void;
}

/** A search hit as the journal-record shape the resume/fork flows consume.
 * The transcript path comes from the index EXPLICITLY (the plugin's
 * `describe` declared it) — the ref stays the opaque handle it claims to be. */
export function hitRecord(hit: SearchHit): SessionRecord {
  const at = new Date(hit.mtime || 0).toISOString();
  return {
    agent: hit.agent,
    sessionId: hit.sessionId,
    cwd: hit.cwd,
    ...(hit.title !== null && { title: hit.title }),
    ...(hit.transcriptPath !== null && { transcriptPath: hit.transcriptPath }),
    boundAt: at,
    state: "closed",
    endedAt: at,
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
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<SearchHit | null>(null);
  const [entries, setEntries] = useState<AgentTranscriptEntry[]>([]);
  const [exhausted, setExhausted] = useState(false);

  // The scan waits for plugin activation (the registry is empty until
  // then), re-firing when readiness lands; the listing itself can show
  // whatever the index already holds from a previous run.
  useEffect(() => {
    api.search("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (ready) api.scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const loadMore = (hit: SearchHit, from: number) => {
    void api
      .transcript(hit.agent, hit.reference, from, PAGE)
      .then((page) => {
        setEntries((current) => (from === 0 ? page : [...current, ...page]));
        setExhausted(page.length < PAGE);
      });
  };

  const openViewer = (hit: SearchHit) => {
    setOpen(hit);
    setEntries([]);
    setExhausted(false);
    loadMore(hit, 0);
  };

  const now = Date.now();
  return (
    <div className="browser">
      <div className="browser__bar">
        <input
          className="browser__search"
          value={query}
          placeholder="Search all sessions — content, titles"
          onChange={(e) => {
            setQuery(e.target.value);
            api.search(e.target.value);
          }}
        />
        {api.scanning && api.hits.length > 0 && (
          // Inside the field, so a background rescan neither shifts layout
          // nor duplicates the empty-list placeholder.
          <span className="browser__scanning">indexing…</span>
        )}
      </div>
      <ul className="history__list browser__list">
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
                <span className="history__name">
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
                title={`Resume in ${hit.cwd}`}
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
        {api.hits.length === 0 && (
          <li className="history__row browser__empty">
            {api.scanning ? "Indexing the stores…" : "No sessions match"}
          </li>
        )}
      </ul>

      {open && (
        <div className="browser__viewer" role="dialog" aria-label="Session transcript">
          <div className="browser__viewer-head">
            <span className="history__name">{open.title ?? open.sessionId}</span>
            <button
              type="button"
              className="history__delete"
              aria-label="Close transcript"
              onClick={() => setOpen(null)}
            >
              ×
            </button>
          </div>
          <div className="browser__viewer-body">
            {entries.map((entry, index) => (
              <div
                key={index}
                className={`browser__turn browser__turn--${entry.role}`}
              >
                {entry.text}
              </div>
            ))}
            {entries.length === 0 && (
              <div className="browser__empty">Loading…</div>
            )}
            {!exhausted && entries.length > 0 && (
              <button
                type="button"
                className="history__resume"
                onClick={() => loadMore(open, entries.length)}
              >
                Load more
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
