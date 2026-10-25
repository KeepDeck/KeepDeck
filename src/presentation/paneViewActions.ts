import type { PaneInputFocusPort } from "./paneInputFocusController";
import { findPane, findWorkspace, hiddenBy, spotlightOn, type DeckState } from "../domain/deck";

/** The view reads the deck, while the app owns its writes. */
export interface PaneViewDeckPort {
  getSnapshot(): DeckState;
}

/** Only the deck transitions that revealing and focusing a pane need. */
export interface PaneViewDeckActionsPort {
  openTeam(workspaceId: string, teamId: string): void;
  toggleMinimize(workspaceId: string, paneId: string): void;
  restoreSuspendedPane(workspaceId: string, paneId: string): void;
  toggleFocus(workspaceId: string, paneId: string): void;
}

/** Capability to bring an addressed pane into view. */
export interface PaneViewPort {
  revealPane(workspaceId: string, paneId: string): void;
}

export interface PaneViewActions extends PaneViewPort {
  toggleMaximize(workspaceId: string, paneId: string): void;
}

/** Presentation policy shared by pane activation, chrome and menu hotkeys. */
export function createPaneViewActions(
  deck: PaneViewDeckPort,
  actions: PaneViewDeckActionsPort,
  paneInputFocus: PaneInputFocusPort,
): PaneViewActions {
  return {
    revealPane(workspaceId, paneId) {
      // The pane's team first: a pane is only ever in front of the person
      // inside its own team, so the level moves before any marker comes
      // off — the restore below highlights the pane, and a highlight has
      // to land on the slice that is then in view.
      const team = findPane(deck.getSnapshot().workspaces, workspaceId, paneId)?.team;
      if (team) actions.openTeam(workspaceId, team.teamId);

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
      const now = deck.getSnapshot();
      const ws = findWorkspace(now.workspaces, workspaceId);
      const maximized = ws ? spotlightOn(ws, now.viewByWs[workspaceId]?.focus, paneId) : null;
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
