import type { MinimizeStyle } from "../domain/settings";
import { createDeckActions } from "./deckActions";
import type { DeckStore } from "./deckStore";

export interface MinimizeSettingsPort {
  minimizeStyle(): MinimizeStyle | null;
  subscribe(listener: () => void): () => void;
}

export interface MinimizePolicy {
  dispose(): void;
}

/**
 * Reconcile the durable minimize preference with session-only deck state.
 *
 * This is application policy rather than rendering: it runs for settings
 * changes and deck hydration even when no React surface is mounted.
 */
export function createMinimizePolicy(
  deck: DeckStore,
  settings: MinimizeSettingsPort,
): MinimizePolicy {
  const actions = createDeckActions(deck);
  let reconciling = false;

  const reconcile = () => {
    if (reconciling || settings.minimizeStyle() !== "none") return;
    const hasManualMinimizes = Object.values(
      deck.getSnapshot().viewByWs,
    ).some((view) => (view.minimized?.length ?? 0) > 0);
    if (!hasManualMinimizes) return;
    reconciling = true;
    try {
      actions.clearMinimized();
    } finally {
      reconciling = false;
    }
  };

  const unsubscribeSettings = settings.subscribe(reconcile);
  const unsubscribeDeck = deck.subscribe(reconcile);
  reconcile();

  return {
    dispose() {
      unsubscribeDeck();
      unsubscribeSettings();
    },
  };
}
