import { useMemo, useSyncExternalStore } from "react";
import { type WorkspaceView } from "../domain/deck";
import { createDeckActions } from "./deckActions";
import type { DeckStore } from "./deckStore";

export type { WorkspaceCreationResult } from "./deckActions";

/** An empty view — the defaults for a workspace with no view entry yet. Shared
 * so `viewOf` returns a stable reference for absent workspaces. */
const EMPTY_VIEW: WorkspaceView = {};

/** The deck surface the application hooks drive (state + bound actions). */
export type Deck = ReturnType<typeof useDeck>;

/**
 * Binds `store` to React: its state, a view selector, and the deck's actions.
 *
 * The hook adds the SUBSCRIPTION and nothing else — the actions are plain
 * dispatch wrappers built by [`createDeckActions`], reachable without a render
 * by the code that drives pane lifecycles. The store itself is owned by the
 * app runtime and passed in as a required argument, so every caller says which
 * store it drives and no two surfaces can silently end up on different ones.
 */
export function useDeck(store: DeckStore) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  // One set per store, so every action is referentially stable: effects can
  // depend on them directly (the minimize-mode effect reconciles the
  // independently-owned settings and deck state on exactly this guarantee).
  const actions = useMemo(() => createDeckActions(store), [store]);
  return {
    ...state,
    /** The workspace's view state (maximize, selection, dock, dock tab), or the
     * shared empty view when it has none yet — read through here so consumers
     * touch one selector, not the raw map shape. */
    viewOf: (wsId: string): WorkspaceView => state.viewByWs[wsId] ?? EMPTY_VIEW,
    ...actions,
  };
}
