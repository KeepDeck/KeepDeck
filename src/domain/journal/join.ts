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
 * fired) — which is NOT an absence and must never read as one. A `hit`
 * carries the store's last-activity stamp (mtime) — the axis half for
 * rows the index knows.
 */
export type JoinEntry =
  | { kind: "hit"; reference: string; title: string | null; mtime: number }
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
   * an absent answer predates a change still in flight (a scan, a
   * revision-bumped re-ask). */
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
   * Undefined when neither has one — the row then shows its SESSION ID
   * (the component's one fallback, both sources alike: the last prop must
   * DISTINGUISH, and the agent is already the glyph). A title EQUAL to
   * the agent's label is not a name; it is the fallback that got frozen
   * into the journal. */
  title: string | undefined;
  /** The read link when one exists — the handle the owning plugin's
   * `transcript()` takes. The journal's own path WINS over the index's:
   * the two sources overlap only halfway, and dropping the journal's
   * would switch off rows that read fine today. */
  read: { source: "journal" | "index"; reference: string } | null;
  /** BOTH sides of the read-link union that exist — the journal's path
   * and the index's reference, in try order (journal first). `read` is
   * what a row SHOWS; this is everything a read may fall through to when
   * the shown one refuses — the union is a fallback, not a display
   * priority. Empty when neither source has anything. */
  readLinks: string[];
  /** The status chip, or null when the row needs none. */
  status: RowStatus | null;
  /** The composite time mark (epoch ms): the conversation's LAST MOVE
   * when the index knows the session, the journal's own mark (bound /
   * closed) otherwise. */
  when: number | null;
}

export function joinJournalRow(
  record: SessionRecord,
  entry: JoinEntry | undefined,
  agentLabel: string | undefined,
  /** The row's index answer MAY STILL CHANGE — a scan in flight, or a
   * re-ask due/in flight after a revision bump. Matters only to a row
   * WITHOUT a read link: there an `absent` entry is a verdict only
   * while false. A row WITH a readable link carries no status at all,
   * whatever the index says — the link itself is tried at click time.
   * The caller composes this flag (scan state OR the enrichment
   * table's own pending flag), so the domain stays the one place that
   * decides what an answer MEANS. */
  answerMayChange: boolean,
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
      readLinks: [],
      status: "wrong-owner",
      when: Date.parse(record.state === "closed" ? record.endedAt : record.boundAt) || null,
    };
  }
  const title =
    meaningfulTitle(record, agentLabel) ??
    (entry?.kind === "hit" ? (entry.title ?? undefined) : undefined);
  const journalPath = record.transcriptPath;
  const indexRef = entry?.kind === "hit" ? entry.reference : undefined;
  const read =
    journalPath !== undefined
      ? { source: "journal" as const, reference: journalPath }
      : indexRef !== undefined
        ? { source: "index" as const, reference: indexRef }
        : null;
  // The union in TRY order, deduped: the journal path first, the index's
  // reference as the spare (identical links count once). `read` above is
  // what the row shows; this is what a refused read falls through to.
  const readLinks: string[] = [];
  if (journalPath !== undefined) readLinks.push(journalPath);
  if (indexRef !== undefined && indexRef !== journalPath) readLinks.push(indexRef);
  // THE COMPOSITE TIME AXIS: the last move in the conversation when the
  // index knows the session (its mtime IS that moment), the journal's own
  // mark otherwise — the user chose the conversation over the pane, and
  // rows the index doesn't know still keep a place on the axis instead of
  // sinking to the end.
  const when =
    entry?.kind === "hit"
      ? entry.mtime
      : (Date.parse(
          record.state === "closed" ? record.endedAt : record.boundAt,
        ) || null);
  // A readable link carries no status, without exceptions: whether the
  // index knows the session or not, the link is tried at click time and
  // the attempt itself reports its own outcome.
  let status: RowStatus | null;
  if (read !== null) {
    // the ONLY status question left is the no-link case
    status = null;
  } else {
    status =
      entry?.kind === "absent"
        ? answerMayChange
          ? "indexing"
          : "nothing-to-read"
        : entry?.kind === "error"
          ? "index-error"
          : "indexing";
  }
  return { record, title, read, readLinks, status, when };
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
