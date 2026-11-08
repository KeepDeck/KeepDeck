import type { UsageCallBatch } from "../domain/usage/history/capture";
import type { UsageRow } from "../domain/usage/history/event";
import type { UsageLedger } from "../domain/usage/history/ledger";
import * as ledgerIpc from "../ipc/usageLedger";
import type { StoredUsageLedger, UsageBookEntry } from "../ipc/usageLedger";

export interface UsageHistorySnapshot {
  ready: boolean;
  /** The rows, and the view a derived value is keyed on (see
   * {@link UsageLedger}): a new view per change of the rows, never an array
   * copy. */
  ledger: UsageLedger;
  error: string | null;
  /**
   * Whether `ledger.events` covers everything the ledger ever recorded.
   * `ready` only means the load has finished. Two states publish a ready
   * snapshot over history the page does not hold:
   *
   * - the load FAILED, and the rows are the initial empty list;
   * - the store left out history it could not read (lines of a newer build,
   *   kept aside by the import).
   *
   * A reader that only displays the rows can ignore this. A reader that
   * writes a durable decision from their ABSENCE cannot: it would be acting
   * on "the user has never done this" when the truth is "this build cannot
   * see what they did".
   */
  complete: boolean;
  /** When the ledger began booking per model (see {@link StoredUsageLedger});
   * null until a load said. */
  perModelSince: number | null;
}

/** The ledger the manager reads and books through — injected, so tests
 * build an instance over fakes instead of mocking modules. */
export interface UsageHistoryIpc {
  loadUsageLedger(): Promise<StoredUsageLedger>;
  bookUsageCalls(entry: UsageBookEntry): Promise<UsageRow[]>;
}

/** How many recorded events the page appends to its copy before it reloads
 * the compacted ledger. The core books everything; the page holds history as
 * buckets plus whatever it appended since the load, and without a reload a
 * long sitting would grow back the raw event list compaction removed. At
 * today's 30–50 events a minute this is a reload every hour or two, and the
 * refold it triggers costs a few milliseconds over a few thousand rows. */
export const RELOAD_AFTER_APPENDS = 3_000;

/** The page's view of the usage ledger, which the core owns: load it, book
 * panes' calls through the core, append the row each booking adds, and
 * expose a subscribable snapshot. Rows are only ever appended — the core
 * answers a booking with what it adds, never with a rewrite of a row the
 * page holds — so a reader folding the rows incrementally stays exact. A factory (not module globals): each
 * instance owns its whole state, so tests construct fresh ones. */
export function createUsageHistoryManager(ipc: UsageHistoryIpc) {
  /** Appended in place — see {@link UsageLedger} for why it is never
   * copied, and why readers key on `ledger` instead. */
  let events: UsageRow[] = [];
  let ledger: UsageLedger = { events, version: 0 };
  /** Whether a load ever succeeded, and what it said about completeness. */
  let loaded = false;
  let storeComplete = false;
  let perModelSince: number | null = null;
  let appendedSinceLoad = 0;
  let snapshot: UsageHistorySnapshot = {
    ready: false,
    ledger,
    error: null,
    complete: false,
    perModelSince,
  };
  let initialization: Promise<void> | null = null;
  /** Loads and records, in order: a reload replaces the rows, and an
   * outcome applied around it would be lost or applied twice. */
  let queue: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();

  /** The rows changed (replaced on load, or appended): mint the view a
   * reader keys its derived values on. */
  function eventsChanged(): void {
    ledger = { events, version: ledger.version + 1 };
  }

  function emit(error: string | null = snapshot.error): void {
    snapshot = {
      ready: true,
      ledger,
      error,
      complete: loaded && storeComplete,
      perModelSince,
    };
    for (const listener of [...listeners]) listener();
  }

  function enqueue(work: () => Promise<void>): Promise<void> {
    const result = queue.catch(() => {}).then(work);
    queue = result;
    return result;
  }

  async function load(): Promise<void> {
    try {
      const stored = await ipc.loadUsageLedger();
      events = stored.rows;
      loaded = true;
      storeComplete = stored.complete;
      perModelSince = stored.perModelSince;
      appendedSinceLoad = 0;
      eventsChanged();
      emit(null);
    } catch (error) {
      emit(String(error));
    }
  }

  /** Load the ledger once. */
  function init(): Promise<void> {
    initialization ??= enqueue(load);
    return initialization;
  }

  /** Book one pane's calls. Bookings run behind the load and behind each
   * other, so rows land in the order the calls were reported. */
  function book(batch: UsageCallBatch, capturedAt = Date.now()): Promise<void> {
    void init();
    return enqueue(async () => {
      const rows = await ipc.bookUsageCalls({ batch, capturedAt });
      if (rows.length === 0) return;
      events.push(...rows);
      appendedSinceLoad += rows.length;
      eventsChanged();
      emit(null);
      if (appendedSinceLoad >= RELOAD_AFTER_APPENDS) await load();
    });
  }

  return {
    init,
    book,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The app's one ledger view, wired to the real IPC. The named exports below
 * are its bound verbs — the stable surface main.tsx, the runtime, the call
 * book and the React hook consume. */
const manager = createUsageHistoryManager(ledgerIpc);

export const initUsageHistory = manager.init;
export const bookUsageCalls = manager.book;
export const getUsageHistorySnapshot = manager.getSnapshot;
export const subscribeUsageHistory = manager.subscribe;
