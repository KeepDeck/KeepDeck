import type { PaneInputFocusPort } from "../app/paneInputFocusPort";
import { createDeckActions } from "../app/deckActions";
import type { DeckStore } from "../app/deckStore";
import type { PaneViewPort } from "../app/paneViewPort";
import { hiddenBy } from "../domain/deck";

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
      // Every reason the pane is off the grid comes off by that reason's own
      // action — a pane can carry both after a suspend from the grid — and
      // the switch is exhaustive, so a reason the layout learns to honour
      // cannot be one the reveal forgets.
      for (const reason of hiddenBy(deck.getSnapshot().viewByWs[workspaceId], paneId)) {
        switch (reason) {
          case "minimized":
            actions.toggleMinimize(workspaceId, paneId);
            break;
          case "suspendedTray":
            actions.restoreSuspendedPane(workspaceId, paneId);
            break;
          default: {
            const unhandled: never = reason;
            throw new Error(`unhandled hide reason: ${String(unhandled)}`);
          }
        }
      }

      // Read again: restoring from either placement drops the maximize in the
      // reducer, and a spotlight decided from the earlier snapshot would bring
      // back a focus that was meant to go.
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
