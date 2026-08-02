import type { PaneInputFocusPort } from "../app/paneInputFocusPort";
import { createDeckActions } from "../app/deckActions";
import type { DeckStore } from "../app/deckStore";
import type { PaneViewPort } from "../app/paneViewPort";

export interface PaneViewActions extends PaneViewPort {
  toggleMaximize(workspaceId: string, paneId: string): void;
}

/** Presentation policy shared by pane activation, chrome and menu hotkeys. */
export function createPaneViewActions(
  deck: DeckStore,
  paneInputFocus: PaneInputFocusPort,
): PaneViewActions {
  const actions = createDeckActions(deck);

  return {
    revealPane(workspaceId, paneId) {
      const view = deck.getSnapshot().viewByWs[workspaceId];
      // A pane can carry both placement markers after a Grid -> List suspend.
      // Remove both before resolving maximize so every activation path gets
      // the same visibility guarantee.
      if (view?.minimized?.includes(paneId)) {
        actions.toggleMinimize(workspaceId, paneId);
      }
      if (view?.suspendedTray?.includes(paneId)) {
        actions.restoreSuspendedPane(workspaceId, paneId);
      }

      const maximized = deck.getSnapshot().viewByWs[workspaceId]?.focus;
      if (maximized && maximized !== paneId) {
        // Preserve fullscreen semantics by switching its spotlight to the
        // addressed pane instead of silently dropping back to the grid.
        actions.toggleFocus(workspaceId, paneId);
      }
    },

    toggleMaximize(workspaceId, paneId) {
      actions.toggleFocus(workspaceId, paneId);
      // The chrome button receives browser focus before its click. Selection
      // may already be unchanged, so an explicit request must follow layout.
      paneInputFocus.requestFocus(paneId);
    },
  };
}
