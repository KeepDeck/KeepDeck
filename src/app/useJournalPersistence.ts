import { useEffect, useRef, useState } from "react";
import {
  decodeJournalLines,
  encodeJournalEvent,
  shouldCompactJournal,
} from "../domain/journal/persist";
import {
  foldJournal,
  snapshotJournal,
  type JournalRecords,
} from "../domain/journal";
import { describeError, log } from "../ipc/log";
import { appendJournal, compactJournal, loadJournal } from "../ipc/journal";
import type { Deck } from "./useDeck";

/** What the boot load produced, held until the deck itself finished
 * restoring (hydration prunes against LIVE workspace ids, so it must never
 * run against a not-yet-restored deck). */
interface LoadedJournal {
  records: JournalRecords;
  compact: boolean;
}

/**
 * `journal.jsonl` persistence ([F8]): load + fold the event log once at boot,
 * hydrate it into the deck after deck.json restored, then drain the reducer's
 * outbox — every queued event appends (one synced write) the moment it lands,
 * so a quit right after closing a pane loses nothing.
 *
 * Ordering is strict and frontend-owned: compaction (when the log earned it)
 * completes before hydration, and appends start only after hydration — the
 * Rust side never sees an append race a compaction rewrite. When the deck is
 * `frozen` (the stored deck needs a newer build) the journal freezes too:
 * hydrating against a parked, empty deck would prune every workspace's
 * history as orphaned.
 */
export function useJournalPersistence(deck: Deck, restoring: boolean, frozen: boolean): void {
  const deckRef = useRef(deck);
  deckRef.current = deck;

  const [loaded, setLoaded] = useState<LoadedJournal | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // 1) Load + decode + fold, once, in parallel with the deck restore.
  useEffect(() => {
    let cancelled = false;
    void loadJournal()
      .then((lines) => {
        if (cancelled) return;
        const { events, garbage, foreign } = decodeJournalLines(lines);
        if (garbage > 0 || foreign > 0) {
          log.warn(
            "web:journal",
            `journal.jsonl: ${garbage} garbage / ${foreign} foreign line(s) skipped`,
          );
        }
        const records = foldJournal(events);
        const recordCount = Object.values(records).reduce(
          (n, list) => n + list.length,
          0,
        );
        setLoaded({
          records,
          compact: shouldCompactJournal(lines.length, recordCount, foreign),
        });
      })
      .catch((e) => {
        if (cancelled) return;
        // An unreadable log must not block the session — start empty; the
        // file stays on disk untouched for a later look.
        log.warn("web:journal", `journal load failed: ${describeError(e)}`);
        setLoaded({ records: {}, compact: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 2) Compact (when earned), then hydrate — once, after the deck restored.
  useEffect(() => {
    if (restoring || frozen || loaded === null || hydrated) return;
    let cancelled = false;
    const run = async () => {
      if (loaded.compact) {
        try {
          await compactJournal(
            snapshotJournal(loaded.records).map(encodeJournalEvent),
          );
        } catch (e) {
          // Compaction is an optimization; the log stays valid without it.
          log.warn("web:journal", `journal compact failed: ${describeError(e)}`);
        }
      }
      if (cancelled) return;
      deckRef.current.hydrateJournal(loaded.records);
      setHydrated(true);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [restoring, frozen, loaded, hydrated]);

  // 3) Drain the outbox: append queued events in order, one flight at a time.
  const appendingRef = useRef(false);
  // A failed append re-arms the drain on a timer: waiting for "the next tail
  // change" alone would lose the queued events if the user goes idle and
  // quits — and durability-per-event is the journal's whole premise.
  const [retryTick, setRetryTick] = useState(0);
  const retryTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    },
    [],
  );
  const tail = deck.journal.tail;
  useEffect(() => {
    if (!hydrated || frozen || appendingRef.current || tail.length === 0) return;
    appendingRef.current = true;
    const count = tail.length;
    void appendJournal(tail.map(encodeJournalEvent))
      .then(() => {
        // Clear the in-flight flag BEFORE the flush dispatch: events that
        // queued during the flight re-fire this effect via the flush's tail
        // change, and must find it free — else they strand until the next
        // event happens to land.
        appendingRef.current = false;
        deckRef.current.journalFlushed(count);
      })
      .catch((e) => {
        appendingRef.current = false;
        log.warn("web:journal", `journal append failed: ${describeError(e)}`);
        if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
        retryTimer.current = window.setTimeout(() => {
          retryTimer.current = null;
          setRetryTick((tick) => tick + 1);
        }, 2000);
      });
  }, [tail, hydrated, frozen, retryTick]);
}
