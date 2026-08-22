import { useRef } from "react";

/**
 * A synchronous one-holder latch: the guard that stops a second click
 * entering an operation the first one is still inside.
 *
 * REF-BACKED ON PURPOSE, and this is the whole reason the primitive
 * exists rather than a `useState` boolean. State lands a render too
 * late: two clicks in one tick both read the pre-render value, both pass
 * the check, and both run. The specific damage that taught this is that
 * a rename is not idempotent — a double ⌘S replayed rename(old→new)
 * after the first had already consumed "old", painting a spurious
 * failure over a rename that worked.
 *
 * It deliberately does NOT carry the render-visible twin. A button that
 * must LOOK disabled needs state, and the two are not the same fact at
 * the same scope: one operation's latch is its own, while "a write is in
 * flight" may cover several. Keeping them apart is what lets each be
 * spelled where it belongs.
 *
 * Turning this into state is the regression this file names so it cannot
 * happen quietly: it would be an edit to a primitive with a docblock,
 * not an invisible change to a local.
 */
export interface Latch {
  /** Held right now — readable synchronously, within the same tick. */
  readonly held: boolean;
  /** Take it. `false` means someone already has it and the caller must
   * not proceed. */
  acquire(): boolean;
  release(): void;
}

export function useLatch(): Latch {
  const held = useRef(false);
  return {
    get held() {
      return held.current;
    },
    acquire() {
      if (held.current) return false;
      held.current = true;
      return true;
    },
    release() {
      held.current = false;
    },
  };
}
