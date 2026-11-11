/**
 * The awards already given — the congratulated set the achievement notifier
 * keeps — published for the surfaces that show earned badges (the gallery,
 * its door's count, Weekly's nearest badges). Earned state is derived from
 * the ledger, but an award is never taken back (user decision, 2026-11-11):
 * a metric re-derived lower, as the per-day ones can be since they moved to
 * the reader's calendar, must not make a won badge read as locked.
 *
 * A tiny store the runtime owns from the start; the notifier, created once
 * the app starts, writes it whenever the set it persists changes.
 */
export interface KeptAchievements {
  getSnapshot(): ReadonlySet<string>;
  subscribe(listener: () => void): () => void;
  publish(ids: ReadonlySet<string>): void;
}

export function createKeptAchievements(): KeptAchievements {
  let kept: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => kept,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(ids) {
      kept = new Set(ids);
      for (const listener of listeners) listener();
    },
  };
}
