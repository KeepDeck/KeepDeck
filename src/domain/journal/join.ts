import type { SessionRecord } from "./sessionLog";

/**
 * The journal row's join with the session index — a PURE function: the
 * record, the index's answer for its (agent, sessionId) key, and the
 * agent's label go in; a display-ready row comes out. No IO, no timing:
 * the asynchronous world (when asks fire, how answers land) lives in the
 * app layer's enrichment store; this file only decides what the answers
 * MEAN.
 */

/**
 * What the index answered for one (agent, sessionId) key — structural, so
 * the ipc layer's `IndexLookupAnswer` maps onto it without this domain
 * importing ipc. `undefined` = no answer yet (ask pending, or never
 * fired) — which is NOT an absence and must never read as one.
 *
 * `hit.stale` marks an answer a LATER ask failed to refresh: kept by the
 * never-degrade rule, flagged so the row can say so.
 */
export type JoinEntry =
  | { kind: "hit"; reference: string; title: string | null; stale?: boolean }
  | { kind: "foreign"; agents: readonly string[] }
  | { kind: "absent" }
  | { kind: "error" };

/** The status a joined row paints instead of disappearing. */
export type RowStatus =
  /** The id exists under ANOTHER agent: the record's attribution is
   * wrong. The row stays visible but must not open or continue — its
   * journal transcriptPath belongs to the wrong plugin. */
  | "wrong-owner"
  /** Temporary: no definitive answer yet — the ask is pending/unfired, or
   * an absent answer predates a scan still in flight. */
  | "indexing"
  /** Definitive: no journal path, no index row, index settled — but the
   * conversation ran here. */
  | "nothing-to-read"
  /** The ask itself failed — never a verdict about the session. */
  | "index-error";

/** One journal row resolved for display. */
export interface JoinedRow {
  record: SessionRecord;
  /** Display title: the record's own MEANINGFUL title, else the index's.
   * Undefined when neither has one — the caller falls back to the agent
   * label, then the agent id. A title EQUAL to the agent's label is not a
   * name; it is the fallback that got frozen into the journal. */
  title: string | undefined;
  /** The read link when one exists — the handle the owning plugin's
   * `transcript()` takes. The journal's own path WINS over the index's:
   * the two sources overlap only halfway, and dropping the journal's
   * would switch off rows that read fine today. */
  read: { source: "journal" | "index"; reference: string } | null;
  /** The status chip, or null when the row needs none. */
  status: RowStatus | null;
  /** The read link comes from an index answer a later ask could not
   * refresh — shown, and named as last-known. */
  stale: boolean;
}

export function joinJournalRow(
  record: SessionRecord,
  entry: JoinEntry | undefined,
  agentLabel: string | undefined,
  scanning: boolean,
): JoinedRow {
  // The wrong-owner guard outranks everything, the journal path included:
  // that path is the record's claim, and the claim is what's broken —
  // reading it would feed a foreign store into the wrong plugin. The row
  // stays visible, named by whatever the record itself honestly knows.
  if (entry?.kind === "foreign") {
    return {
      record,
      title: meaningfulTitle(record, agentLabel),
      read: null,
      status: "wrong-owner",
      stale: false,
    };
  }
  const title =
    meaningfulTitle(record, agentLabel) ??
    (entry?.kind === "hit" ? (entry.title ?? undefined) : undefined);
  const read =
    record.transcriptPath !== undefined
      ? { source: "journal" as const, reference: record.transcriptPath }
      : entry?.kind === "hit"
        ? { source: "index" as const, reference: entry.reference }
        : null;
  // A read link makes the row need no status — regardless of what the
  // index said or failed to say, the row opens. Only link-less rows
  // paint one, and an absent answer is definitive ONLY while no scan is
  // in flight (batches still landing can add the session); pending and
  // failed asks are their own states, never "nothing to read".
  const status =
    read !== null
      ? null
      : entry?.kind === "absent"
        ? scanning
          ? "indexing"
          : "nothing-to-read"
        : entry?.kind === "error"
          ? "index-error"
          : "indexing";
  return {
    record,
    title,
    read,
    status,
    stale: read?.source === "index" && entry?.kind === "hit" && entry.stale === true,
  };
}

/** The record's own title when it says something the fallback row
 * wouldn't: a title identical to the agent's LABEL is the fallback that
 * got frozen at seal time — indistinguishable from no title at all. */
function meaningfulTitle(
  record: SessionRecord,
  agentLabel: string | undefined,
): string | undefined {
  if (record.title === undefined) return undefined;
  if (agentLabel !== undefined && record.title === agentLabel) return undefined;
  return record.title;
}
