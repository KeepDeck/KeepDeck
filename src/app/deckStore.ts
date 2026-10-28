import {
  deckReducer,
  initialDeckState,
  type DeckAction,
  type DeckState,
  type TitleAgent,
} from "../domain/deck";

export interface DeckStore {
  getSnapshot(): DeckState;
  subscribe(listener: () => void): () => void;
  /** Apply one domain transition synchronously and return its resulting state. */
  dispatch(action: DeckAction): DeckState;
  /** What naming a pane needs from the agent catalog, read now — the deck's
   * actions title a sealed journal record with it, as the header showed. */
  titleAgents(): readonly TitleAgent[];
}

/** The store as wiring that only watches the deck sees it: what is there
 * now, and when that changes. The report lanes and the status channel read
 * the deck and never move it, so they take this rather than the store — a
 * dispatch cannot creep into them unseen, and their tests need no stand-in
 * for one. */
export type DeckWatch = Pick<DeckStore, "getSnapshot" | "subscribe">;

/**
 * One synchronous owner for deck state. Commands need the result of a create
 * immediately (for provisioning and same-batch ID allocation), while React
 * only needs a consistent subscription. Keeping the reducer here satisfies
 * both without replaying every action through a second render-time state
 * machine.
 */
export function createDeckStore(
  initialState: DeckState = initialDeckState,
  /** The live agent catalog. A deck with none names panes by what their
   * terminals said, undecorated by nothing — no glyph is stripped. */
  titleAgents: () => readonly TitleAgent[] = () => [],
): DeckStore {
  let state = initialState;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => state,
    titleAgents,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(action) {
      const next = deckReducer(state, action);
      if (next === state) return state;
      state = next;
      for (const listener of [...listeners]) listener();
      return state;
    },
  };
}
