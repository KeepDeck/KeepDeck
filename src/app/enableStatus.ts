import type { EnableTransition } from "./enablePolicy";

/**
 * A backend's last enable transition — one cell per feature, outside
 * React.
 *
 * Why it exists: when a store is not open, the STORE cannot say why. It
 * knows only that it is closed, so it answers every reader with one
 * sentence — "turn <feature> on first" — which is a lie whenever the
 * feature IS on and the enable failed for another reason (another
 * KeepDeck process owning the claim, an unwritable home). The reason
 * exists exactly once, in the transition that failed, and dies in a log
 * line unless something keeps it.
 *
 * Kept VERBATIM: what it means is the reader's to decide (a settings row
 * and a dialog want different sentences from the same fact).
 */
export interface EnableStatus {
  /** The last transition, or `null` before the first one settles. */
  last(): EnableTransition | null;
  subscribe(listener: () => void): () => void;
  record(transition: EnableTransition): void;
}

export function createEnableStatus(): EnableStatus {
  let last: EnableTransition | null = null;
  const listeners = new Set<() => void>();
  return {
    last: () => last,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    record(transition) {
      last = transition;
      // A copy: a listener that unsubscribes inside its own call would
      // otherwise mutate the set being iterated.
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * Why the backend is shut, when it is — `null` while the last transition
 * landed, or none has happened yet. An OFF setting is not a failure and
 * carries no reason: the user turned it off, and they can see that.
 */
export function refusalOf(last: EnableTransition | null): string | null {
  if (last === null || last.ok || !last.desired) return null;
  return last.detail;
}
