import type { WorkspaceView } from "../domain/deck";
import { createDeckActions } from "./deckActions";
import type { DeckStore } from "./deckStore";
import type { Deck } from "./useDeck";

const EMPTY_VIEW: WorkspaceView = {};

/** Read the current plain application surface over a deck store. */
export function readDeck(store: DeckStore): Deck {
  const state = store.getSnapshot();
  return {
    ...state,
    viewOf: (wsId: string): WorkspaceView =>
      state.viewByWs[wsId] ?? EMPTY_VIEW,
    ...createDeckActions(store),
  };
}
