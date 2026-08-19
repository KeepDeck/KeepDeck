import type { JoinEntry } from "./join";
import type { SessionRecord } from "./sessionLog";
import { joinJournalRow } from "./join";
import { rowOfJoined, type UnifiedSessionRow } from "./sessionRow";

/** The identity of a session row — "agent:sessionId". The ONE spelling:
 * dedup keys, enrichment keys and React `key`s all ride this. */
export const rowKeyOf = (key: { agent: string; sessionId: string }): string =>
  `${key.agent}:${key.sessionId}`;

/** The journal-record query predicate — which bound rows stay VISIBLE
 * under an active query. The index search matches CONTENT the client
 * never sees, so the journal half filters on what it has: title,
 * directory, branch, session id. Deliberately the JOURNAL's fields, not
 * the joined title: enrichment paints cells, it never decides
 * composition — a title arriving late must not make a filtered row
 * vanish or appear. (The top block's INDEX half searches by content
 * with everything else — the union keeps both kinds findable.) */
export function journalRecordMatches(
  record: SessionRecord,
  query: string,
): boolean {
  if (query === "") return true;
  const q = query.toLowerCase();
  return [record.title, record.cwd, record.branch, record.sessionId].some(
    (field) => field !== undefined && field.toLowerCase().includes(q),
  );
}

/** What one session block's composition resolved to: the rows to draw
 * and the counter over EXACTLY those rows. The counter fields are the
 * block's own — numerator what it DRAWS, denominator what it CAN draw —
 * so the truth of the count is the composition rule's, computed where
 * the rule lives. */
export interface ComposedBlock {
  rows: UnifiedSessionRow[];
  /** The drawn-row count — `rows.length`, carried so the counter reads
   * as the composition's own output rather than a re-measure elsewhere. */
  shown: number;
  /** What the block can eventually draw. Before full load this is an
   * UPPER BOUND: the difference to `shown` is the count of index hits
   * NOT YET LOADED — not a promise of that many future visible rows
   * (some may yet prove to be twins). Monotone toward zero; exact at
   * full load. */
  total: number;
  /** Whether the block's index half has more pages to load — the
   * caller's paging stays on the raw engine totals (a filtered total
   * fed back would stop loading early); this is display-side truth. */
  hasMore: boolean;
}

export interface ComposeSessionBlocksInput {
  /** The workspace's journal records (newest binding first). */
  records: SessionRecord[];
  /** The active query text, verbatim from the box. */
  query: string;
  /** The shared enrichment table's answers, keyed by [`rowKeyOf`]. */
  entries: ReadonlyMap<string, JoinEntry>;
  /** The agent-label lookup, as DATA (a function in, a string out) —
   * the domain takes it and stays pure. */
  agentLabel: (agentId: string) => string | undefined;
  /** Whether an index answer may still change (scan state OR the
   * enrichment table's own pending). */
  answerMayChange: boolean;
  /** The agents whose stores the settled scan proved walked whole —
   * the file-erased verdict's precondition. */
  scannedAgents: ReadonlySet<string>;
  /** The top block's loaded index hits, already mapped to rows. */
  topHits: UnifiedSessionRow[];
  /** The bottom block's loaded index hits, already mapped to rows. */
  bottomHits: UnifiedSessionRow[];
  /** The top engine's own total (raw, unadjusted). */
  topTotal: number;
  /** The top engine's loaded hit count. */
  topLoaded: number;
  /** The bottom engine's own total (raw, unadjusted). */
  bottomTotal: number;
  /** The bottom engine's loaded hit count. */
  bottomLoaded: number;
  /** The bottom engine's own hasMore (raw). */
  bottomHasMore: boolean;
}

/**
 * The two session blocks' composition — ONE entry point, not a toolkit.
 * The top block is the workspace's sessions: journal records (by the
 * recorded fact of binding, whatever folder they name) united with the
 * workspace-folder index hits, deduped by journal KEY against the
 * VISIBLE records, on ONE composite time axis. The bottom block is
 * everything else: the exclusion query's hits minus the same twins.
 *
 * The counters leave here too: their truth is the composition rule's
 * (what counts as a row of this block), so they are computed where the
 * rule is. The paging engines' raw totals are INPUTS only — feeding a
 * filtered total back would stop loading early.
 */
export function composeSessionBlocks(
  input: ComposeSessionBlocksInput,
): { top: ComposedBlock; bottom: ComposedBlock } {
  const {
    records,
    query,
    entries,
    agentLabel,
    answerMayChange,
    scannedAgents,
    topHits,
    bottomHits,
    topTotal,
    topLoaded,
    bottomTotal,
    bottomLoaded,
    bottomHasMore,
  } = input;

  // ── The top block's journal half ───────────────────────────────────
  const journalFiltered = records.filter((record) =>
    journalRecordMatches(record, query),
  );
  const journalPart = journalFiltered.map((record) =>
    rowOfJoined(
      joinJournalRow(
        record,
        entries.get(rowKeyOf(record)),
        agentLabel(record.agent),
        answerMayChange,
        scannedAgents.has(record.agent),
      ),
    ),
  );

  // The VISIBLE journal keys — the dedup base for BOTH index halves: an
  // index row the journal already shows is the top block's by binding
  // FACT, wherever its (possibly EMPTY) cwd falls. Visible, not full: a
  // journal row the query hid (its match is content-only) must still be
  // findable through its index hit, not vanish from both blocks.
  const journalKeys = new Set(journalFiltered.map(rowKeyOf));

  const topKept = topHits.filter((hit) => !journalKeys.has(rowKeyOf(hit)));
  const bottomKept = bottomHits.filter((hit) => !journalKeys.has(rowKeyOf(hit)));

  // ── ONE axis for the whole top block ──────────────────────────────
  // The conversation's last move (the row's `when` — index mtime where
  // known, the journal mark otherwise), newest first. Concatenating the
  // two halves instead would leave journal rows standing by BINDING
  // time under an axis that claims to be conversation time; and a row
  // the index doesn't know keeps its journal-mark place among the mtime
  // rows instead of sinking below them all. Stable sort: equal marks
  // keep their half's order. The re-seating when a scan batch lands IS
  // the accepted §07 price — insertion by time shifts what sits below,
  // and the block says so.
  const topRows = [...journalPart, ...topKept].sort(
    (a, b) => (b.when ?? -Infinity) - (a.when ?? -Infinity),
  );

  // ── The counters, over exactly the drawn population ───────────────
  // Twins among the LOADED hits are rows the engines counted but this
  // block will never draw (the journal draws them, or they are the
  // empty-cwd fall-through) — subtract them from the denominator.
  // `max` is load-bearing, not cosmetics: the engine's type does not
  // promise loaded ≤ total (a shrinking total between pages makes the
  // state reachable), and without the floor the invariant numerator ≤
  // denominator would break on that input alone.
  const topTwins = topHits.length - topKept.length;
  const bottomTwins = bottomHits.length - bottomKept.length;
  const topTotalShown =
    journalFiltered.length + Math.max(topTotal, topLoaded) - topTwins;
  const bottomTotalShown = Math.max(bottomTotal, bottomLoaded) - bottomTwins;

  return {
    top: {
      rows: topRows,
      shown: topRows.length,
      total: topTotalShown,
      hasMore: false,
    },
    bottom: {
      rows: bottomKept,
      shown: bottomKept.length,
      total: bottomTotalShown,
      hasMore: bottomHasMore,
    },
  };
}
