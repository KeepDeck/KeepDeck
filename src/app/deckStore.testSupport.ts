import type { DeckState, Pane } from "../domain/deck";
import { deckState, workspace } from "../domain/deck/reducer.testSupport";
import { createDeckStore, type DeckStore } from "./deckStore";

/** A deck holding one workspace, `ws-1`, with exactly these panes — the
 * shape the report lanes and channels are asked about. */
export const deckStateOf = (panes: Pane[]): DeckState =>
  deckState({ workspaces: [{ ...workspace("ws-1", []), panes }] });

/** The real store over that deck. */
export const deckStoreOf = (panes: Pane[]): DeckStore =>
  createDeckStore(deckStateOf(panes));
