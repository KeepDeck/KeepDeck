import type { JoinedRow, RowStatus } from "./join";
import type { SessionHandle } from "./sessionLog";

/** The identity of a session row — "agent:sessionId". The ONE spelling:
 * dedup keys, enrichment keys and React `key`s all ride this. Lives here,
 * beside the row type it keys: enrichment (a PRECONDITION of composition)
 * imports it from the row's own home, not from the composition module —
 * a dependency from consequence back to premise would read circular even
 * without a module cycle. */
export const rowKeyOf = (key: { agent: string; sessionId: string }): string =>
  `${key.agent}:${key.sessionId}`;

/** What BOTH sources carry on a row — the shared shape the union narrows
 * from. A row's SOURCE is the row's own fact (`kind`), not a field of
 * something the row may not have. */
interface SessionRowBase {
  agent: string;
  sessionId: string;
  cwd: string;
  /** Display title, source preference already resolved upstream. */
  title: string | undefined;
  /** The full read-link chain (a refused read falls through it). */
  readLinks: string[];
  /** The row's time mark (epoch ms) — the axis is composite upstream.
   * Null is the BOUND row's honest silence (no mark, no place on the
   * axis); an index row always has mtime. */
  when: number | null;
  /** What the resume/fork flows consume. */
  handle: SessionHandle;
}

/** A journal-BOUND row — the workspace's own record, joined with the
 * index. Its source-locked fields: the pane's owned worktree branch may
 * honestly be unset (not recorded); liveness is always KNOWN (live or
 * closed — KeepDeck itself bound it); a content-search snippet never
 * exists (the journal has no content match to show). `status` carries
 * the verdict chips — a wrong-owner verdict is always about a row the
 * JOURNAL vouches for. The read link may be NULL: the
 * join found nothing to read. */
export interface BoundSessionRow extends SessionRowBase {
  kind: "bound";
  /** The read link the row SHOWS — the fallback chain's first link.
   * Null: nothing to read anywhere. */
  read: { reference: string } | null;
  branch: string | undefined;
  liveness: "live" | "closed";
  status: RowStatus | null;
}

/** An INDEX row — a search hit the journal does not vouch for. Its
 * source-locked fields: the read link ALWAYS exists (the hit was found
 * BY it); branch, liveness and status are not merely unset — they DO
 * NOT EXIST on this variant, because no fact of the journal backs them
 * (an index row with a verdict chip is a category error: verdicts are
 * about bindings). The snippet exists only when a content search
 * matched — an honest emptiness, not a missing fact. */
export interface IndexSessionRow extends SessionRowBase {
  kind: "index";
  read: { reference: string };
  snippet: string | null;
}

/** The ONE row shape both sessions blocks render, as a union over the
 * source — the second half of the step's requirement: the blocks differ
 * by WHICH side of the boundary a session sits, never by markup, and a
 * source's silence is an empty cell, not a different template. The
 * union removes the IMPOSSIBLE crosses BETWEEN sources (a bound row
 * with a snippet, an index row with liveness); the honest emptinesses
 * WITHIN a source stay (no branch recorded, empty query, no time mark).
 *
 * The discriminator is the row's own `kind` — the old nested
 * `read.source` was read by NOBODY and could not discriminate anyway
 * (read may be null on a bound row). */
export type UnifiedSessionRow = BoundSessionRow | IndexSessionRow;

/** A journal-bound row as a unified row — the join's output, re-shaped;
 * nothing re-decided here. */
export function rowOfJoined(joined: JoinedRow): BoundSessionRow {
  const record = joined.record;
  return {
    kind: "bound",
    agent: record.agent,
    sessionId: record.sessionId,
    cwd: record.cwd,
    title: joined.title,
    read: joined.read === null ? null : { reference: joined.read.reference },
    readLinks: joined.readLinks,
    branch: record.branch,
    liveness: record.state === "live" ? "live" : "closed",
    status: joined.status,
    when: joined.when,
    handle: record,
  };
}

/** An index hit as a unified row: its one read link is the plugin ref the
 * search found it by (and that fact is the variant's guarantee — the
 * link exists). Branch, liveness and status are absent BY TYPE. */
export function rowOfHit(hit: {
  agent: string;
  sessionId: string;
  reference: string;
  cwd: string;
  title: string | null;
  transcriptPath: string | null;
  mtime: number;
  snippet?: string | null;
}): IndexSessionRow {
  return {
    kind: "index",
    agent: hit.agent,
    sessionId: hit.sessionId,
    cwd: hit.cwd,
    title: hit.title ?? undefined,
    read: { reference: hit.reference },
    readLinks: [hit.reference],
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
