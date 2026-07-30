import {
  foldJournal,
  snapshotJournal,
  type JournalRecords,
} from "../domain/journal";
import {
  decodeJournalLines,
  encodeJournalEvent,
  shouldCompactJournal,
} from "../domain/journal/persist";
import { appendJournal, compactJournal, loadJournal } from "../ipc/journal";
import { describeError, log } from "../ipc/log";
import { createDeckActions } from "./deckActions";
import type { DeckPersistence } from "./deckPersistence";
import type { DeckStore } from "./deckStore";

interface LoadedJournal {
  records: JournalRecords;
  compact: boolean;
}

export interface JournalPersistence {
  dispose(): void;
}

/** App-lifetime owner of journal load, hydrate, compaction and append order. */
export function createJournalPersistence(
  deck: DeckStore,
  persistence: DeckPersistence,
): JournalPersistence {
  const actions = createDeckActions(deck);
  let loaded: LoadedJournal | null = null;
  let hydrateStarted = false;
  let hydrated = false;
  let appending = false;
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function clearRetry(): void {
    if (retryTimer === null) return;
    globalThis.clearTimeout(retryTimer);
    retryTimer = null;
  }

  function drain(): void {
    if (disposed) return;
    void hydrateIfReady();
    const { frozen } = persistence.getSnapshot();
    const tail = deck.getSnapshot().journal.tail;
    if (!hydrated || frozen !== null || appending || tail.length === 0) return;
    appending = true;
    const count = tail.length;
    void appendJournal(tail.map(encodeJournalEvent)).then(
      () => {
        if (disposed) return;
        appending = false;
        actions.journalFlushed(count);
        drain();
      },
      (error) => {
        if (disposed) return;
        appending = false;
        log.warn(
          "web:journal",
          `journal append failed: ${describeError(error)}`,
        );
        clearRetry();
        retryTimer = globalThis.setTimeout(() => {
          retryTimer = null;
          drain();
        }, 2000);
      },
    );
  }

  async function hydrateIfReady(): Promise<void> {
    const state = persistence.getSnapshot();
    if (
      hydrateStarted ||
      state.restoring ||
      state.frozen !== null ||
      loaded === null
    ) {
      return;
    }
    hydrateStarted = true;
    if (loaded.compact) {
      try {
        await compactJournal(
          snapshotJournal(loaded.records).map(encodeJournalEvent),
        );
      } catch (error) {
        log.warn(
          "web:journal",
          `journal compact failed: ${describeError(error)}`,
        );
      }
    }
    if (disposed) return;
    actions.hydrateJournal(loaded.records);
    hydrated = true;
    drain();
  }

  const unsubscribeDeck = deck.subscribe(drain);
  const unsubscribePersistence = persistence.subscribe(drain);

  void loadJournal()
    .then((lines) => {
      if (disposed) return;
      const { events, garbage, foreign } = decodeJournalLines(lines);
      if (garbage > 0 || foreign > 0) {
        log.warn(
          "web:journal",
          `journal.jsonl: ${garbage} garbage / ${foreign} foreign line(s) skipped`,
        );
      }
      const records = foldJournal(events);
      const recordCount = Object.values(records).reduce(
        (count, list) => count + list.length,
        0,
      );
      loaded = {
        records,
        compact: shouldCompactJournal(lines.length, recordCount, foreign),
      };
      drain();
    })
    .catch((error) => {
      if (disposed) return;
      log.warn(
        "web:journal",
        `journal load failed: ${describeError(error)}`,
      );
      loaded = { records: {}, compact: false };
      drain();
    });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      clearRetry();
      unsubscribeDeck();
      unsubscribePersistence();
    },
  };
}
