/**
 * One correlated host→realm call, waiting for its answer.
 *
 * The host mints an id, pushes the question on a channel keyed by it, and the
 * guest's reply lands later under the same id. Four kinds of question ride
 * this shape — spawn hooks, history reads, live-session queries, file-open
 * offers — and they differ only in the channel, the deadline, and what a
 * successful answer means. The waiting itself is identical, so it is written
 * once here instead of four times at the call sites.
 *
 * The deadline is the point. A hung or dead realm must never strand a caller:
 * every call carries a timer that rejects it, `settle` ignores an id that has
 * already timed out, and `failAll` empties the queue when the bridge goes
 * away. Without those three the spawn pipeline could freeze on a guest that
 * simply never answers.
 */

export type RealmReply<T> = { ok: true; value: T } | { ok: false; error: string };

export interface PendingCalls<T> {
  /** Push one call and await its reply. `label` names it in a timeout error,
   * so the message says which question went unanswered. */
  call(payload: unknown, label: string): Promise<T>;
  /** Land a reply from the realm. An id that already timed out, was swept, or
   * was never ours is ignored rather than throwing. */
  settle(id: number, reply: RealmReply<T>): void;
  /** Fail everything still waiting — the bridge is going away, and a pending
   * promise must not outlive it. */
  failAll(error: string): void;
}

export function createPendingCalls<T>(
  push: (channel: string, payload: unknown) => void,
  channel: (id: number) => string,
  timeoutMs: number,
): PendingCalls<T> {
  let nextId = 1;
  const waiting = new Map<number, (reply: RealmReply<T>) => void>();

  return {
    call(payload, label) {
      return new Promise<T>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          // Delete FIRST: the guard is that a later reply for this id finds
          // nothing and settles nothing.
          if (waiting.delete(id))
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        waiting.set(id, (reply) => {
          clearTimeout(timer);
          if (!reply.ok) return reject(new Error(reply.error));
          resolve(reply.value);
        });
        push(channel(id), payload);
      });
    },
    settle(id, reply) {
      const land = waiting.get(id);
      if (!land) return;
      waiting.delete(id);
      land(reply);
    },
    failAll(error) {
      for (const land of waiting.values()) land({ ok: false, error });
      waiting.clear();
    },
  };
}
