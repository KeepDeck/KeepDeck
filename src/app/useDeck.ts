import { useReducer } from "react";
import { deckReducer, initialDeckState } from "../domain/deck";
import type { Pane } from "../domain/panes";
import type { Workspace } from "../domain/workspaces";

/**
 * Owns the deck's reducer and exposes the state plus bound action helpers, so
 * `App` drives the deck through one well-typed surface instead of juggling four
 * coupled `useState`s and cleaning them by hand on every removal.
 */
export function useDeck() {
  const [state, dispatch] = useReducer(deckReducer, initialDeckState);
  return {
    ...state,
    selectWorkspace: (id: string) => dispatch({ type: "selectWorkspace", id }),
    createWorkspace: (workspace: Workspace) =>
      dispatch({ type: "createWorkspace", workspace }),
    setPanes: (id: string, panes: Pane[]) =>
      dispatch({ type: "setPanes", id, panes }),
    addAgentPane: (id: string, pane: Pane) =>
      dispatch({ type: "addAgentPane", id, pane }),
    renameWorkspace: (id: string, name: string) =>
      dispatch({ type: "renameWorkspace", id, name }),
    moveWorkspace: (id: string, toIndex: number) =>
      dispatch({ type: "moveWorkspace", id, toIndex }),
    closeAgent: (wsId: string, paneId: string) =>
      dispatch({ type: "closeAgent", wsId, paneId }),
    closeWorkspace: (id: string) => dispatch({ type: "closeWorkspace", id }),
    toggleFocus: (wsId: string, paneId: string) =>
      dispatch({ type: "toggleFocus", wsId, paneId }),
    selectPane: (wsId: string, paneId: string) =>
      dispatch({ type: "selectPane", wsId, paneId }),
    renamePane: (wsId: string, paneId: string, name: string) =>
      dispatch({ type: "renamePane", wsId, paneId, name }),
    setPaneAutoTitle: (wsId: string, paneId: string, title: string) =>
      dispatch({ type: "setPaneAutoTitle", wsId, paneId, title }),
  };
}
