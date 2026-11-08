/**
 * When this run first saw each pane's session — the deck's clock at the
 * moment the session was accepted for the pane.
 *
 * The usage history books no call older than the first time it saw a
 * session: that one rule drops a fork's copied calls for every agent, and
 * what a session spent before KeepDeck watched it (user decision
 * 2026-11-08). Two lanes need the SAME instant for it — the tail, to read a
 * file again only from where the ledger would still book, and the call book,
 * to tell the ledger when the session was first seen — so it is kept here,
 * once, and both read it.
 *
 * The ledger keeps the earliest sighting it was ever told, so a session seen
 * in an earlier run keeps that run's instant; this only answers for sessions
 * the ledger has not met.
 */
export interface UsageSightings {
  /** The instant `sessionId` was first seen in `paneId` this run, recorded
   * now when it was not seen yet. */
  sight(paneId: string, sessionId: string): number;
  /** Forget the panes that are gone. */
  retain(liveIds: ReadonlySet<string>): void;
}

export function createUsageSightings(now: () => number = Date.now): UsageSightings {
  const seen = new Map<string, Map<string, number>>();
  return {
    sight(paneId, sessionId) {
      let sessions = seen.get(paneId);
      if (!sessions) {
        sessions = new Map();
        seen.set(paneId, sessions);
      }
      const known = sessions.get(sessionId);
      if (known !== undefined) return known;
      const at = now();
      sessions.set(sessionId, at);
      return at;
    },
    retain(liveIds) {
      for (const paneId of [...seen.keys()]) {
        if (!liveIds.has(paneId)) seen.delete(paneId);
      }
    },
  };
}
