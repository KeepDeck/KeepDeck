import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { indexLookup, type IndexLookupKey } from "../ipc/history";
import { describeError, log } from "../ipc/log";
import type { JoinEntry } from "../domain/journal";

/** The join key of a journal row — same shape the index lookup takes. */
export type RowKey = IndexLookupKey;

export const rowKeyOf = (key: RowKey): string => `${key.agent}:${key.sessionId}`;

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
 * The ASK is shared and batched: one `index_lookup` per change (a new
 * declaration, an index revision bump), covering every declared key that
 * hasn't been answered `hit` — hits are stable, everything else
 * (unanswered, absent, foreign, errored) re-asks, so a scan's
 * landed batches fill titles in as they arrive. A scan rebuilds in
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
): {
  entries: ReadonlyMap<string, JoinEntry>;
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
  /** The generation of the newest in-flight ask — a superseded landing
   * applies nothing (the newer ask re-covers its keys). */
  const askSeq = useRef(0);
  /** Keys covered by the newest in-flight ask. The mount path fires the
   * effect twice for ONE declaration (the declared ref mutates before the
   * tick the effect re-runs on) — without the same-set guard every browser
   * mount would put a duplicate ask in flight and throw the first answer
   * away. A superseded ask's landing applies nothing, so any NEW ask
   * always carries the FULL still-owed set. */
  const inflightRef = useRef(new Set<string>());
  /** The (revision, scanning) the newest ask fired under. A revision bump
   * means the index moved under an in-flight ask — its answer may already
   * be stale data, so the same-set skip never applies across one. */
  const askEnvRef = useRef<{ revision: number; scanning: boolean } | null>(null);

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

  useEffect(() => {
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
    // The mount path fires this effect twice for ONE declaration (the
    // declared ref mutates before the tick the effect re-runs on). Skip
    // only when the in-flight ask IS this ask UNDER THE SAME index state —
    // a revision bump or a partial overlap must still fire, carrying the
    // full set: the newer ask supersedes the older one's landing, so
    // dropping an overlapping key here would leave it unanswered until
    // the next change.
    const inflight = inflightRef.current;
    const env = askEnvRef.current;
    const sameEnv =
      env !== null && env.revision === revision && env.scanning === scanning;
    if (
      sameEnv &&
      inflight.size === ids.length &&
      ids.every((id) => inflight.has(id))
    ) {
      return;
    }
    const mine = ++askSeq.current;
    inflightRef.current = new Set(ids);
    askEnvRef.current = { revision, scanning };

    /** Fold one landed ask into the table. A refusal (`failed`) keeps
     * every prior answer verbatim — never an erasure, never a downgrade —
     * and names itself only where nothing was known. */
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
        ask.forEach((key, at) => {
          const answer = answers[at];
          if (answer === undefined) return;
          const id = rowKeyOf(key);
          if (answer.status === "hit") {
            next.set(id, {
              kind: "hit",
              reference: answer.reference,
              title: answer.title,
            });
          } else if (answer.status === "foreign") {
            next.set(id, { kind: "foreign", agents: answer.agents });
          } else {
            next.set(id, { kind: "absent" });
          }
        });
      }
      entriesRef.current = next;
      setEntries(next);
    };

    void indexLookup(ask)
      .then((answers) => {
        if (askSeq.current !== mine) return;
        inflightRef.current = new Set();
        apply(answers, false);
      })
      .catch((e: unknown) => {
        if (askSeq.current !== mine) return;
        inflightRef.current = new Set();
        log.warn("web:history", `journal join lookup failed: ${describeError(e)}`);
        apply(null, true);
      });
  }, [revision, scanning, declaredTick]);

  return { entries, declare };
}
