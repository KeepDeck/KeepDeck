import type { UsageEventV2 } from "../domain/usage/history/event";
import { localDayNumber, type LocalDayNumber } from "../domain/usage/time";
import type { UsageHistorySnapshot } from "./usageHistoryManager";
import type { UsageSnapshot } from "./usageManager";

/**
 * THE one home of "on which days was the reader actually here" — the question
 * behind the streak chip, and the only place that decides what counts as
 * evidence.
 *
 * Activity has TWO witnesses and they have different lifetimes:
 *
 * - the LEDGER, which is durable but LATE. The first report of a session
 *   seeds a baseline and appends nothing (so a resumed session's inherited
 *   counters are not counted twice), and codex's opening `turn_context`
 *   carries a model with no tokens at all — so nothing reaches the file
 *   until a turn actually spends. That gap is a whole first turn, which is
 *   why the count used to sit on yesterday's number while the user was
 *   plainly working.
 * - a LIVE REPORT, which is immediate but TRANSIENT. It is emitted from an
 *   agent's own answer, so it means the same thing the ledger means, only
 *   sooner — but it lives in `usage.panes`, and that map is emptied by
 *   `clearPane` on a session generation change (`/clear`, `/new`), by a pane
 *   restart, by a close, and by every app restart.
 *
 * Reading the two straight off their stores — which the chip did — makes the
 * count a function of PANE MEMBERSHIP: it went up when a pane arrived and
 * DOWN when one left, so typing `/clear` could drop the streak by a day, or
 * unmount the chip entirely, with nothing the user did being undone. A day
 * that has been witnessed stays witnessed. This store is monotone: days only
 * ever go in.
 *
 * It also keeps exactly ONE instant per day. That is what makes the
 * downstream memo cheap: `activeAt` changes identity only when a NEW day
 * appears — roughly once a day — instead of on every bridge report, so the
 * never-pruned ledger (69k events and counting) is scanned once per append
 * here rather than once per report in a component.
 *
 * Not persisted, deliberately. Across an app restart the ledger is the only
 * witness left, so a day whose activity never became spend is forgotten —
 * which is the honest answer, because at that point nothing durable ever saw
 * it. It heals on the first spend.
 */

export interface ActivityWitnessSnapshot {
  /** One instant per calendar day the reader was active, in insertion order.
   * Stable identity between changes — the `useSyncExternalStore` contract,
   * and what keeps the streak recompute off the hot path. */
  activeAt: readonly number[];
  /** The newest instant any witness has claimed. Feeds the wall clock's
   * `atLeast`, so a report that outran the 30 s tick is not discarded by the
   * streak's own `at > now` guard — the reason the ledger already floors it. */
  latestAt: number;
}

export interface ActivityWitness {
  getSnapshot(): ActivityWitnessSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface ActivityWitnessDeps {
  history: {
    getSnapshot(): UsageHistorySnapshot;
    subscribe(listener: () => void): () => void;
  };
  usage: {
    getSnapshot(): UsageSnapshot;
    subscribe(listener: () => void): () => void;
  };
}

export function createActivityWitness(
  deps: ActivityWitnessDeps,
): ActivityWitness {
  /** Day → the instant that first proved it. One entry per day, so the
   * exported array is short and its identity is quiet. */
  const firstOfDay = new Map<LocalDayNumber, number>();
  let activeAt: readonly number[] = [];
  let latestAt = 0;
  let snapshot: ActivityWitnessSnapshot = { activeAt, latestAt };
  const listeners = new Set<() => void>();
  /** Appends are folded incrementally — the unbounded ledger is never
   * re-scanned per append. `firstFolded` is the wholesale-replacement guard:
   * length alone cannot detect a same-or-longer replacement with different
   * content (a compaction rewrite). */
  let processed = 0;
  let firstFolded: UsageEventV2 | undefined;
  let disposed = false;

  function emit(): void {
    snapshot = { activeAt, latestAt };
    for (const listener of [...listeners]) listener();
  }

  /** Record one instant. Returns whether anything actually changed — a
   * report on a day already witnessed only moves the clock floor. */
  function admit(at: number): boolean {
    if (!Number.isFinite(at) || at <= 0) return false;
    let changed = false;
    if (at > latestAt) {
      latestAt = at;
      changed = true;
    }
    const day = localDayNumber(at);
    if (!firstOfDay.has(day)) {
      firstOfDay.set(day, at);
      activeAt = [...firstOfDay.values()];
      changed = true;
    }
    return changed;
  }

  function foldHistory(): void {
    if (disposed) return;
    const { ready, events } = deps.history.getSnapshot();
    if (!ready) return;
    if (events.length < processed || (processed > 0 && events[0] !== firstFolded)) {
      // Replaced wholesale. Re-admit from the start rather than rebuilding:
      // the map is monotone on purpose, and a compaction only ever drops
      // torn or duplicate lines — never a day the reader actually had.
      processed = 0;
      firstFolded = undefined;
    }
    let changed = false;
    for (let index = processed; index < events.length; index += 1) {
      changed = admit(events[index].occurredAt) || changed;
    }
    if (processed === 0 && events.length > 0) firstFolded = events[0];
    processed = events.length;
    if (changed) emit();
  }

  function foldUsage(): void {
    if (disposed) return;
    let changed = false;
    for (const pane of deps.usage.getSnapshot().panes.values()) {
      changed = admit(pane.reportedAt) || changed;
    }
    if (changed) emit();
  }

  const unsubscribeHistory = deps.history.subscribe(foldHistory);
  const unsubscribeUsage = deps.usage.subscribe(foldUsage);
  // Whatever both stores already hold — a witness constructed after either
  // has published must not start blind.
  foldHistory();
  foldUsage();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      unsubscribeHistory();
      unsubscribeUsage();
      listeners.clear();
    },
  };
}
