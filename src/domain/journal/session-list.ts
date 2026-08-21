import type { JoinEntry } from "./join";
import type { SessionRecord } from "./sessionLog";
import { joinJournalRow } from "./join";
import { rowOfJoined, rowKeyOf, type UnifiedSessionRow } from "./sessionRow";

/** The journal-record query predicate — which bound rows stay VISIBLE
 * under an active query. The index search matches CONTENT the client
 * never sees, so the journal half filters on what it has: title,
 * directory, branch, session id. Deliberately the JOURNAL's fields, not
 * the joined title: enrichment paints cells, it never decides
 * composition — a title arriving late must not make a filtered row
 * vanish or appear. (The workspace lane's INDEX half searches by
 * content with everything else — the union keeps both kinds findable.) */
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

/** What one lane of the list's composition resolved to: the rows to
 * draw and the counter over EXACTLY those rows. The counter fields are
 * the lane's own — numerator what it DRAWS, denominator what it CAN
 * draw — so the truth of the count is the composition rule's, computed
 * where the rule lives. No `hasMore` here on purpose: the
 * bare-total-vs-"X of N" choice is `shown === total`, the composition's
 * own truth — equal exactly when the drawn population has reached its
 * bound — and the paging engine's raw hasMore stays with the engine. */
export interface ComposedLane {
  rows: UnifiedSessionRow[];
  /** The drawn-row count — `rows.length`, carried so the counter reads
   * as the composition's own output rather than a re-measure elsewhere. */
  shown: number;
  /** What the lane can eventually draw. Before full load this is an
   * UPPER BOUND: the difference to `shown` is the count of index hits
   * NOT YET LOADED — not a promise of that many future visible rows
   * (some may yet prove to be twins). Monotone toward zero; exact at
   * full load. */
  total: number;
}

export interface ComposeSessionListInput {
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
  /** The workspace lane's loaded index hits (the Only-scope engine's),
   * already mapped to rows. The LOADED count is this array's own length
   * — carried as data, not duplicated as a second number: a caller-fed
   * pair could disagree with the array and break the very invariant
   * the max floor guards. */
  workspaceHits: UnifiedSessionRow[];
  /** The other lane's loaded index hits (the Except-scope engine's),
   * already mapped to rows. */
  otherHits: UnifiedSessionRow[];
  /** The workspace engine's own total (raw, unadjusted). */
  workspaceTotal: number;
  /** The other engine's own total (raw, unadjusted). */
  otherTotal: number;
}

/**
 * The session list's composition — ONE entry point, not a toolkit. The
 * list draws one queue in a fixed order: the WORKSPACE lane first
 * (the workspace's own sessions — journal records by the recorded fact
 * of binding, whatever folder they name, united with the
 * workspace-folder index hits, deduped by journal KEY against the
 * VISIBLE records, on ONE composite time axis), then the OTHER lane
 * (the exclusion query's hits minus the same twins). Belonging outranks
 * time: an other-lane row never passes above a workspace row, however
 * fresh.
 *
 * The counters leave here too: their truth is the composition rule's
 * (what counts as a row of this list), so they are computed where the
 * rule is. The paging engines' raw totals are INPUTS only — feeding a
 * filtered total back would stop loading early.
 */
export function composeSessionList(
  input: ComposeSessionListInput,
): {
  workspaceLane: ComposedLane;
  otherLane: ComposedLane;
  listCount: { shown: number; total: number };
} {
  const {
    records,
    query,
    entries,
    agentLabel,
    answerMayChange,
    workspaceHits,
    otherHits,
    workspaceTotal,
    otherTotal,
  } = input;

  // ── The workspace lane's journal half ─────────────────────────────
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
      ),
    ),
  );

  // The VISIBLE journal keys — the dedup base for BOTH index halves: an
  // index row the journal already shows is the workspace lane's by
  // binding FACT, wherever its (possibly EMPTY) cwd falls. Visible, not
  // full: a journal row the query hid (its match is content-only) must
  // still be findable through its index hit, not vanish from the list.
  const journalKeys = new Set(journalFiltered.map(rowKeyOf));

  const workspaceKept = workspaceHits.filter(
    (hit) => !journalKeys.has(rowKeyOf(hit)),
  );
  const otherKept = otherHits.filter((hit) => !journalKeys.has(rowKeyOf(hit)));

  // ── ONE axis for the workspace lane ───────────────────────────────
  // The conversation's last move (the row's `when` — index mtime where
  // known, the journal mark otherwise), newest first. Concatenating the
  // two halves instead would leave journal rows standing by BINDING
  // time under an axis that claims to be conversation time; and a row
  // the index doesn't know keeps its journal-mark place among the mtime
  // rows instead of sinking below them all. Stable sort: equal marks
  // keep their half's order. A landed index answer re-seats the row to
  // its index mtime — the transition is characterized in
  // SessionsBrowser.join.integration.test.tsx; it is not the price §07
  // described, which was the insertion of ANOTHER row while a row's own
  // key stayed put.
  const workspaceRows = [...journalPart, ...workspaceKept].sort(
    (a, b) => (b.when ?? -Infinity) - (a.when ?? -Infinity),
  );

  // ── The counters, over exactly the drawn population ───────────────
  // Twins among the LOADED hits are rows the engines counted but this
  // list will never draw twice (the journal draws them, or they are the
  // empty-cwd fall-through) — subtract them from the denominator.
  // `max` is load-bearing on BOTH lanes, not cosmetics: the engine's
  // type does not promise loaded ≤ total (a shrinking total between
  // pages makes the state reachable — the lower guard pins this shape),
  // and without the floor the invariant numerator ≤ denominator breaks
  // on that input alone. The loaded count is the array's own length —
  // no second number to disagree with it.
  const workspaceTwins = workspaceHits.length - workspaceKept.length;
  const otherTwins = otherHits.length - otherKept.length;
  const workspaceTotalShown =
    journalFiltered.length +
    Math.max(workspaceTotal, workspaceHits.length) -
    workspaceTwins;
  const otherTotalShown =
    Math.max(otherTotal, otherHits.length) - otherTwins;

  return {
    workspaceLane: {
      rows: workspaceRows,
      shown: workspaceRows.length,
      total: workspaceTotalShown,
    },
    otherLane: {
      rows: otherKept,
      shown: otherKept.length,
      total: otherTotalShown,
    },
    // The search field's count — the count of THIS LIST, the summary of
    // its two lanes, not a third lane (no rows of its own). Its total
    // is a MOVING composite bound: it shifts as pages load, when a late
    // twin lands, and on a new scan; shown ≤ total always, with
    // equality exactly when both lanes are fully loaded on a stable
    // index snapshot — no fixed "everything there is" is promised. And
    // it is the sum of THIS composition's lanes, not "everything in
    // the app": a third lane would change the sum here, not at the
    // consumer. The summands are the COMPOSED numbers only — the twin
    // deductions and the max-floor above are already in them; the
    // engines' raw totals never enter this addition.
    listCount: {
      shown: workspaceRows.length + otherKept.length,
      total: workspaceTotalShown + otherTotalShown,
    },
  };
}
