import type { JoinedRow, RowStatus } from "./join";
import type { SessionHandle } from "./sessionLog";

/**
 * The ONE row shape both sessions blocks render — the second half of the
 * step's requirement: the blocks differ by WHICH side of the boundary a
 * session sits, never by markup. A source's silence is an empty cell, and
 * an empty cell is an honest answer: branch and the live dot exist only
 * for sessions KeepDeck itself bound; a snippet exists only as a search
 * result, never as a session's property.
 *
 * Pure data, no IO: journal rows arrive as the join's [`JoinedRow`]
 * (already resolved against the index), index rows as a structural hit;
 * the mappings below are the only places that know which source a row
 * came from.
 */
export interface UnifiedSessionRow {
  agent: string;
  sessionId: string;
  cwd: string;
  /** Display title, source preference already resolved upstream. */
  title: string | undefined;
  /** The read link the row SHOWS — the fallback chain's first link. */
  read: { source: "journal" | "index"; reference: string } | null;
  /** The full read-link chain (a refused read falls through it). */
  readLinks: string[];
  /** The pane's owned worktree branch — bound sessions only. */
  branch: string | undefined;
  /** Liveness as the source knows it: bound sessions are live or closed;
   * an index row cannot know — `null` renders no dot at all, because a
   * closed-looking dot would claim knowledge the store never gave. */
  liveness: "live" | "closed" | null;
  /** The row's status chip, or null when the row needs none. */
  status: RowStatus | null;
  /** The row's time mark (epoch ms) — the axis is composite upstream. */
  when: number | null;
  /** A content-search snippet — present only in search results. */
  snippet: string | null;
  /** What the resume/fork flows consume. */
  handle: SessionHandle;
}

/** A journal-bound row as a unified row — the join's output, re-shaped;
 * nothing re-decided here. */
export function rowOfJoined(joined: JoinedRow): UnifiedSessionRow {
  const record = joined.record;
  return {
    agent: record.agent,
    sessionId: record.sessionId,
    cwd: record.cwd,
    title: joined.title,
    read: joined.read,
    readLinks: joined.readLinks,
    branch: record.branch,
    liveness: record.state === "live" ? "live" : "closed",
    status: joined.status,
    when: joined.when,
    snippet: null,
    handle: record,
  };
}

/** An index hit as a unified row: its one read link is the plugin ref the
 * search found it by; branch and liveness are honestly absent. */
export function rowOfHit(hit: {
  agent: string;
  sessionId: string;
  reference: string;
  cwd: string;
  title: string | null;
  transcriptPath: string | null;
  mtime: number;
  snippet?: string | null;
}): UnifiedSessionRow {
  return {
    agent: hit.agent,
    sessionId: hit.sessionId,
    cwd: hit.cwd,
    title: hit.title ?? undefined,
    read: { source: "index", reference: hit.reference },
    readLinks: [hit.reference],
    branch: undefined,
    liveness: null,
    status: null,
    when: hit.mtime,
    snippet: hit.snippet ?? null,
    handle: {
      agent: hit.agent,
      sessionId: hit.sessionId,
      cwd: hit.cwd,
      ...(hit.title !== null && { title: hit.title }),
      ...(hit.transcriptPath !== null && {
        transcriptPath: hit.transcriptPath,
      }),
    },
  };
}
