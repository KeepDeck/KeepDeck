import { useSyncExternalStore } from "react";
import type {
  DeckPark,
  DeckPersistence,
} from "./deckPersistence";

/**
 * Deck persistence ([F7]): restore the saved deck once on boot, then save the
 * live deck (debounced; atomic on the Rust side) on every change. `restoring`
 * gates the first paint so the empty first-run form doesn't flash before the
 * restored deck arrives.
 */
/** The deck on disk needs a newer reader — this session runs parked. */
/** Why this session is parked: it starts empty and NOTHING it does may reach
 * disk. One value rather than a boolean beside a detail record, because
 * `frozen` gates four separate things — the deck save, the journal hydrate,
 * the skills prune and the notice — and a park that only some of them can see
 * is worse than no park at all: the deck survives while the journal and the
 * staged skills are swept as orphans of a deck that was never loaded. */
export type { DeckPark } from "./deckPersistence";

export function usePersistence(persistence: DeckPersistence): {
  restoring: boolean;
  /** Set when the stored deck may not be written: the session starts empty
   * and NOTHING reaches disk. See [`DeckPark`] for the two reasons. */
  frozen: DeckPark | null;
} {
  return useSyncExternalStore(
    persistence.subscribe,
    persistence.getSnapshot,
    persistence.getSnapshot,
  );
}
