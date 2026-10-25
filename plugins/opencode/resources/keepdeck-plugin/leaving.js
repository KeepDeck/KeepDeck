// @ts-check
/**
 * The user left the pane's conversation (follower.js) — what the pane does
 * about it, for either opencode generation's reporter.
 *
 * For another conversation, the move rebinds the pane; all that is left here
 * is the left session's `interrupt`, when the generation stops what it
 * leaves. For none at all (`/new`), the pane lets go of it: `session.unbound`
 * — the pane has no conversation until the next one binds, and a restore
 * starts fresh (src/app/paneUnbinding.ts).
 *
 * WHETHER LEAVING STOPS A SESSION is the generation's to say, through
 * `interrupt`. opencode 1.x has one session on screen, and leaving it is the
 * user's word that it is not wanted (task-435): it is aborted, and the pane
 * lets go once its ending — which opencode publishes even for an idle
 * session — has gone to the deck as the pane's, so the deck shows the turn
 * ended rather than the pane frozen mid-work (`ended`). If no ending comes,
 * it lets go anyway. opencode 2.x keeps a tab per session and runs the ones
 * left behind to completion (measured on 2.1.2); leaving a tab stops nothing
 * (user decision, task-436), so with no `interrupt` the pane lets go at once.
 *
 * - `pane` — the process's pane session (pane-session.js).
 * - `enqueue(job)` — the reporter's queue: letting go is one of its jobs, so
 *   it never lands between two of the reporter's own.
 * - `interrupt(sessionID)` — optional; called OUTSIDE that queue, because
 *   the interruption's own events queue there and waiting on them from
 *   inside would wait forever.
 * - `onLetGo()` — the pane let go: what the reporter last said about a turn
 *   belonged to the conversation left.
 */

/** How long to wait for an interruption's ending before letting go. */
const LET_GO_MS = 3_000;

/** @typedef {{ root: string | undefined, detach: () => boolean }} PaneSession */
/** @typedef {{ sessionID: string, done: () => void, timer: NodeJS.Timeout | undefined }} LeavingState */

/** @param {{ pane: PaneSession, publish: (type: string, payload: Record<string, unknown>) => unknown, enqueue: (job: () => Promise<void>) => Promise<unknown>, interrupt?: (sessionID: string) => Promise<unknown>, onLetGo?: () => void }} options */
export function createLeaving({ pane, publish, enqueue, interrupt, onLetGo }) {
  /** @type {LeavingState | undefined} */
  let leaving;

  /** @param {string} sessionID */
  const letGo = (sessionID) => {
    if (leaving?.sessionID !== sessionID) return;
    const { done, timer } = leaving;
    leaving = undefined;
    clearTimeout(timer);
    // Not if the pane moved on meanwhile: the next conversation is not the
    // one left, and unbinding would forget it.
    if (pane.root === sessionID && pane.detach()) {
      onLetGo?.();
      publish("session.unbound", {});
    }
    done();
  };

  /** @param {string} sessionID */
  const stop = async (sessionID) => {
    if (!interrupt) return;
    try {
      await interrupt(sessionID);
    } catch {
      // Best-effort: the pane leaves it either way.
    }
  };

  return {
    /** The user left `sessionID` — for another conversation (`replaced`),
     * or for none. Resolves once the pane let go of it. */
    /** @param {string} sessionID @param {{ replaced?: boolean }} [options] */
    async leave(sessionID, { replaced = false } = {}) {
      if (replaced) {
        if (interrupt) await stop(sessionID);
        return;
      }
      // Armed BEFORE the interruption: its ending may be handled before the
      // call even returns.
      /** @type {Promise<void>} */
      const gone = new Promise((done) => {
        if (leaving) letGo(leaving.sessionID);
        const timer = interrupt
          ? setTimeout(() => enqueue(async () => letGo(sessionID)), LET_GO_MS)
          : undefined;
        timer?.unref?.();
        leaving = { sessionID, done, timer };
      });
      if (interrupt) await stop(sessionID);
      else await enqueue(async () => letGo(sessionID));
      await gone;
    },
    /** `sessionID`'s ending reached the deck as the pane's: if it is the one
     * being left, the pane lets go of it now. */
    /** @param {string} sessionID */
    ended(sessionID) {
      if (leaving?.sessionID === sessionID) letGo(sessionID);
    },
  };
}
