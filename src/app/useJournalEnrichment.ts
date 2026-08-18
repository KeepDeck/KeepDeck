import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { indexLookup, type IndexLookupKey } from "../ipc/history";
import { describeError, log } from "../ipc/log";
import type { JoinEntry } from "../domain/journal";

/** The join key of a journal row — same shape the index lookup takes. */
export type RowKey = IndexLookupKey;

export const rowKeyOf = (key: RowKey): string => `${key.agent}:${key.sessionId}`;

/** The stable EMPTY invalidation set — a fresh `new Set()` per call would
 * give the default a new identity every render and fire the purge check
 * for nothing. */
const NO_INVALIDATION: ReadonlySet<string> = new Set();

/**
 * The journal rows' shared enrichment table — the answer side of the
 * browser seam's join with the session index.
 *
 * The answers live in ONE keyed table (keyed by the ROW, "agent:sessionId"),
 * never in a shared "last response" cell: several lists stay mounted at
 * once (one per empty workspace, hidden not unmounted) with DIFFERENT rows,
 * and a last-response cell would let a hidden list's answer overwrite
 * another workspace's. Keyed by row, an answer can only ever land on the
 * row it was asked for — the same key in two workspaces' journals is the
 * same truth for both, and a deleted row's entry simply stops rendering
 * (the list draws its rows from the journal; the table is a keyed cache
 * the rows read, never a source of rows).
 *
 * The ASK is shared, batched and SINGLE-FLIGHT: one `index_lookup` per
 * change (a new declaration, an index revision bump), covering every
 * declared key that hasn't been answered `hit` — hits are stable,
 * everything else (unanswered, absent, foreign, errored) re-asks, so a
 * scan's landed batches fill titles in as they arrive. While an ask is
 * in flight a change never fires a SECOND one: it queues exactly ONE
 * catch-up pass, which fires after the landing with the FULL still-owed
 * set of that moment — however many changes piled up mid-flight (peer-4
 * measured a synthetic burst piling ten concurrent asks; the generation
 * counter kept every one of them harmless, but the seam owed back-
 * pressure, not just correctness). Single-flight also makes a foreign
 * landing structurally impossible — at most one ask exists — which is
 * why there is no generation counter to guard one. A scan rebuilds in
 * 16-session batches — a hundred-plus revision bumps — which is exactly
 * why the ask must be one shared fetch, not one per mounted list.
 *
 * While no scan has ever run and none is running (revision 0, not
 * scanning), nothing is asked at all: the freshness owner is the one who
 * decides when the index can answer, and rows stay in the explicit
 * "not answered yet" state instead of collecting absences from an index
 * that has never been filled.
 *
 * Failure never degrades the known: a refused ask keeps every prior
 * answer verbatim (an `absent` stays absent, a `foreign` stays foreign)
 * and only names itself — an `error` entry — where nothing was known
 * before. (A `hit` is never re-asked, so it cannot be degraded either;
 * there is deliberately no "stale" state to reach.)
 */
export function useJournalEnrichment(
  revision: number,
  scanning: boolean,
  /** The "agent:sessionId" keys the last settled scan PRUNED from the
   * index — a hit on such a key outlived its session and is a lie. The
   * set's IDENTITY moves only when a pass actually dropped something;
   * each new identity purges its keys from the table, and the ask in
   * the same effect run re-covers them (rowKeyOf format). */
  invalidated: ReadonlySet<string> = NO_INVALIDATION,
): {
  entries: ReadonlyMap<string, JoinEntry>;
  /** The table may still change: an ask is in flight, or the index has
   * moved (revision bumped) since the last answer landed — a re-ask is
   * due. The join treats an `absent` as PROVISIONAL while true; only
   * scan-settled AND answered-under-the-current-revision is a verdict.
   * Render-pure by design: it must already hold in the FIRST render
   * after a scan-end publish, which lands `scanning:false` and the
   * revision bump together — before any effect can fire the re-ask. */
  pending: boolean;
  declare(keys: ReadonlyArray<RowKey>): void;
} {
  /** Every key any mounted list has declared — the union; lists unmount
   * silently (in the normal case they only hide), so declarations only
   * ever grow, bounded by the journals themselves. */
  const declaredRef = useRef(new Map<string, RowKey>());
  const [entries, setEntries] = useState<ReadonlyMap<string, JoinEntry>>(
    () => new Map(),
  );
  const entriesRef = useRef(entries);
  /** Advances on every new declaration — the effect's only handle on a
   * change that is neither a revision bump nor a scan-state flip. */
  const [declaredTick, declareMore] = useReducer((n: number) => n + 1, 0);
  /** Advances when a landed ask owes its catch-up pass — the effect's
   * handle on the coalescing seam's "exactly one behind" signal. */
  const [chaseTick, chaseMore] = useReducer((n: number) => n + 1, 0);
  /** An ask is in flight — the single-flight invariant. At most one ask
   * exists at any moment, so no landing can be foreign and no generation
   * counter is needed to sort them.
   *
   * ACCEPTED TRADE, stated with its history (a review pass prompted
   * checking what predated this design): a never-settling ask — the
   * bridge into another process can do that — is an OLD risk; the
   * generations design did not cancel one either. What single-flight
   * changed is the CONSEQUENCE, not the risk. Before, a hung ask was
   * harmless litter: the next change still fired a fresh ask (the old
   * skip matched only the SAME index state), so the seam recovered on
   * the very next bump. Single-flight spends exactly that recovery to
   * buy no pile-up: a hung ask now wedges the one queued catch-up
   * behind it — nothing fires again, rows stay "indexing…" until
   * restart. The wedge stays benign: the mildest of the five states,
   * never lost data or a false verdict, and journal-path rows keep
   * opening. Success and refusal both land; only the third outcome
   * hangs — see `landed`, the one exit. A timer was weighed and
   * declined (median ask 0.16ms; machinery against a hypothesis). */
  const flyingRef = useRef(false);
  /** A change arrived while an ask was flying: ONE catch-up pass is owed
   * after the landing — however many changes piled up, the queue holds a
   * flag, not a backlog. */
  const reaskQueuedRef = useRef(false);
  /** Keys covered by the in-flight ask. The mount path fires the effect
   * twice for ONE declaration (the declared ref mutates before the tick
   * the effect re-runs on) — the same-set check keeps the second run
   * from queueing a spurious chase for the very ask already flying. */
  const inflightRef = useRef(new Set<string>());
  /** The (revision, scanning, invalidated-identity) the in-flight ask
   * fired under. A revision bump means the index moved under the ask;
   * an INVALIDATION-identity bump means sessions were pruned since the
   * ask left — and its "hit" answers about those keys are lies the
   * landing must not write. */
  const askEnvRef = useRef<{
    revision: number;
    scanning: boolean;
    invalidated: ReadonlySet<string>;
  } | null>(null);
  /** An ask is in flight right now (the rendered half of `flyingRef`). */
  const [askInFlight, setAskInFlight] = useState(false);
  /** The revision the last LANDED ask fired under — null before any
   * landing. `pending` = in flight OR answered under an older revision:
   * the second half is what holds at the scan-end boundary frame, where
   * the publish flipped `scanning` and bumped the revision in one
   * re-render and the re-ask effect has not run yet. */
  const [answeredAt, setAnsweredAt] = useState<number | null>(null);

  const declare = useCallback((keys: ReadonlyArray<RowKey>) => {
    const declared = declaredRef.current;
    let added = false;
    for (const key of keys) {
      const id = rowKeyOf(key);
      if (!declared.has(id)) {
        declared.set(id, key);
        added = true;
      }
    }
    if (added) declareMore();
  }, []);

  /** The last invalidation set the table already purged — identity
   * comparison, so an untouched set re-purges nothing. */
  const purgedRef = useRef<ReadonlySet<string>>(invalidated);
  /** DEATH GENERATIONS: each key's death count. A purge that names a key
   * bumps its generation — however many scans settle in one flight, each
   * death is counted, never replaced. An ask records the generations at
   * takeoff; a landing accepts an answer for a key only if its
   * generation is UNCHANGED — an answer flown before any of its deaths
   * cannot resurrect it, and the key stays owed until an answer born
   * after its last death lands. */
  const generationsRef = useRef(new Map<string, number>());

  useEffect(() => {
    // A purge lands FIRST in this effect's run: the pruned keys' hits are
    // lies from this moment, the ask this same run issues must not skip
    // them as "already answered", and each named key's DEATH GENERATION
    // bumps — the accumulating memory invalidation sets never had. A pass
    // that dropped nothing keeps the set's identity — no purge, no bump.
    if (invalidated !== purgedRef.current) {
      purgedRef.current = invalidated;
      if (invalidated.size > 0) {
        const next = new Map(entriesRef.current);
        const generations = generationsRef.current;
        for (const key of invalidated) {
          next.delete(key);
          generations.set(key, (generations.get(key) ?? 0) + 1);
        }
        entriesRef.current = next;
        setEntries(next);
      }
    }
    // Before any scan has run (and none in flight), the index cannot
    // answer honestly — see the header. Not an error, not an absence:
    // simply nothing asked yet.
    if (!scanning && revision === 0) return;
    const declared = declaredRef.current;
    const known = entriesRef.current;
    const ask: RowKey[] = [];
    const ids: string[] = [];
    for (const [id, key] of declared) {
      const entry = known.get(id);
      // Hits are stable and never re-asked; everything else still owes
      // an answer that a landed batch may change.
      if (entry === undefined || entry.kind !== "hit") {
        ask.push(key);
        ids.push(id);
      }
    }
    if (ids.length === 0) return;
    if (flyingRef.current) {
      // An ask is in flight. The mount path fires this effect twice for
      // ONE declaration: the second run must neither fire nor queue —
      // the flying ask IS this ask. Anything genuinely different (a
      // revision bump, a wider declaration, a death) queues exactly ONE
      // catch-up; a partial fire here would strand keys, because the
      // catch-up replaces the flying ask's landing as the newest answer.
      const inflight = inflightRef.current;
      const env = askEnvRef.current;
      const sameEnv =
        env !== null &&
        env.revision === revision &&
        env.scanning === scanning &&
        env.invalidated === invalidated;
      if (
        sameEnv &&
        inflight.size === ids.length &&
        ids.every((id) => inflight.has(id))
      ) {
        return;
      }
      reaskQueuedRef.current = true;
      return;
    }
    const firedRevision = revision;
    // Firing IS the catch-up when one was queued: the flag clears here,
    // not in the landing, so changes arriving during this ask queue the
    // next pass rather than being swallowed by the last one.
    reaskQueuedRef.current = false;
    flyingRef.current = true;
    inflightRef.current = new Set(ids);
    askEnvRef.current = { revision, scanning, invalidated };
    // The DEATH GENERATIONS at takeoff — per key, so any death during the
    // flight (not merely the latest set's contents) disqualifies its
    // answer. Answers carry their own keys; the landing folds BY KEY and
    // simply does not take a disqualified key's answer — nothing is
    // filtered positionally, ever.
    const firedGenerations = new Map(generationsRef.current);
    setAskInFlight(true);

    /** Fold one landed ask into the table, BY KEY. A refusal (`failed`)
     * keeps every prior answer verbatim — never an erasure, never a
     * downgrade — and names itself only where nothing was known. An
     * answer whose key DIED mid-flight (generation moved) is not taken:
     * the key stays owed and the catch-up re-covers it. */
    const apply = (
      answers: Awaited<ReturnType<typeof indexLookup>> | null,
      failed: boolean,
    ): void => {
      const next = new Map(entriesRef.current);
      if (failed) {
        for (const key of ask) {
          const id = rowKeyOf(key);
          if (!next.has(id)) next.set(id, { kind: "error" });
        }
      } else if (answers !== null) {
        // BY KEY, order-independent: an answer lands on the key it names,
        // never on a position. Belonging is the answer's own.
        const generations = generationsRef.current;
        for (const answer of answers) {
          const id = rowKeyOf(answer);
          if ((firedGenerations.get(id) ?? 0) !== (generations.get(id) ?? 0)) {
            continue; // died mid-flight — its answer is not taken
          }
          if (answer.status === "hit") {
            next.set(id, {
              kind: "hit",
              reference: answer.reference,
              title: answer.title,
              mtime: answer.mtime,
            });
          } else if (answer.status === "foreign") {
            next.set(id, { kind: "foreign", agents: answer.agents });
          } else {
            next.set(id, { kind: "absent" });
          }
        }
      }
      entriesRef.current = next;
      setEntries(next);
    };

    /** The one landing path — single-flight makes it the only ask that
     * could ever land. Retires the flight, records the revision it
     * answered, and fires the owed catch-up pass (if any) by re-running
     * the effect with the state of THIS moment. Mid-flight deaths are
     * resolved inside `apply` per key — the whole answer is never
     * discarded, only the dead keys' entries are not taken. */
    const landed = (
      answers: Awaited<ReturnType<typeof indexLookup>> | null,
      failed: boolean,
    ): void => {
      flyingRef.current = false;
      inflightRef.current = new Set();
      setAskInFlight(false);
      setAnsweredAt(firedRevision);
      apply(answers, failed);
      if (reaskQueuedRef.current) {
        reaskQueuedRef.current = false;
        chaseMore();
      }
    };

    void indexLookup(ask).then(
      (answers) => landed(answers, false),
      (e: unknown) => {
        log.warn("web:history", `journal join lookup failed: ${describeError(e)}`);
        landed(null, true);
      },
    );
  }, [revision, scanning, declaredTick, chaseTick, invalidated]);

  return {
    entries,
    pending: askInFlight || answeredAt !== revision,
    declare,
  };
}
