import { useCallback, useReducer, useRef } from "react";
import {
  deckReducer,
  initialDeckState,
  type DeckAction,
  type DeckState,
  type Pane,
  type PaneSession,
  type Workspace,
  type WorkspaceView,
} from "../domain/deck";
import { mintWorkspaceSeq } from "./ids";

/** An empty view — the defaults for a workspace with no view entry yet. Shared
 * so `viewOf` returns a stable reference for absent workspaces. */
const EMPTY_VIEW: WorkspaceView = {};

/** The deck surface the application hooks drive (state + bound actions). */
export type Deck = ReturnType<typeof useDeck>;

/**
 * Owns the deck's reducer and exposes the state plus bound action helpers, so
 * `App` drives the deck through one well-typed surface instead of juggling four
 * coupled `useState`s and cleaning them by hand on every removal.
 */
export function useDeck() {
  const [state, reactDispatch] = useReducer(deckReducer, initialDeckState);
  // React may batch several commands before rendering. Track the state after
  // every queued reducer transition synchronously so an allocator owned here
  // sees earlier commands in the same batch instead of a stale render snapshot.
  const queuedState = useRef(state);
  queuedState.current = state;
  const dispatch = useCallback((action: DeckAction): DeckState => {
    const next = deckReducer(queuedState.current, action);
    queuedState.current = next;
    reactDispatch(action);
    return next;
  }, []);
  // Stable because the minimize-mode effect depends on this command while it
  // reconciles the independently-owned settings and deck state.
  const clearMinimized = useCallback(
    () => dispatch({ type: "clearMinimized" }),
    [],
  );
  return {
    ...state,
    /** The workspace's view state (maximize, selection, dock, dock tab), or the
     * shared empty view when it has none yet — read through here so consumers
     * touch one selector, not the raw map shape. */
    viewOf: (wsId: string): WorkspaceView => state.viewByWs[wsId] ?? EMPTY_VIEW,
    selectWorkspace: (id: string) => dispatch({ type: "selectWorkspace", id }),
    createWorkspace: (workspace: Workspace) =>
      dispatch({ type: "createWorkspace", workspace }),
    /** Build and insert a workspace against the latest queued deck state.
     * Allocation and insertion are one synchronous state-owner operation, so
     * two creates in one React batch cannot observe or append the same id. */
    createWorkspaceFromSequence: (
      build: (sequence: number) => Workspace,
    ): Workspace => {
      const sequence = mintWorkspaceSeq(
        queuedState.current.workspaces.map((workspace) => workspace.id),
      );
      const workspace = build(sequence);
      dispatch({ type: "createWorkspace", workspace });
      return workspace;
    },
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
    toggleMinimize: (wsId: string, paneId: string) =>
      dispatch({ type: "toggleMinimize", wsId, paneId }),
    clearMinimized,
    selectPane: (wsId: string, paneId: string) =>
      dispatch({ type: "selectPane", wsId, paneId }),
    toggleDock: (wsId: string) => dispatch({ type: "toggleDock", wsId }),
    setDockTab: (wsId: string, tabId: string) =>
      dispatch({ type: "setDockTab", wsId, tabId }),
    renamePane: (wsId: string, paneId: string, name: string) =>
      dispatch({ type: "renamePane", wsId, paneId, name }),
    setPaneAutoTitle: (wsId: string, paneId: string, title: string) =>
      dispatch({ type: "setPaneAutoTitle", wsId, paneId, title }),
    hydrate: (state: DeckState) => dispatch({ type: "hydrate", state }),
    revivePane: (wsId: string, paneId: string) =>
      dispatch({ type: "revivePane", wsId, paneId }),
    resetPaneLocation: (wsId: string, paneId: string) =>
      dispatch({ type: "resetPaneLocation", wsId, paneId }),
    setPaneSession: (wsId: string, paneId: string, session: PaneSession | null) =>
      dispatch({ type: "setPaneSession", wsId, paneId, session }),
    resolvePaneProvisioning: (
      wsId: string,
      paneId: string,
      worktree: { cwd: string; branch: string },
    ) =>
      dispatch({
        type: "resolvePaneProvisioning",
        wsId,
        paneId,
        cwd: worktree.cwd,
        branch: worktree.branch,
      }),
    setPaneProvisioningError: (wsId: string, paneId: string, error: string | null) =>
      dispatch({ type: "setPaneProvisioningError", wsId, paneId, error }),
    setPaneProvisioningPhase: (wsId: string, paneId: string, phase: "setup") =>
      dispatch({ type: "setPaneProvisioningPhase", wsId, paneId, phase }),
    setWorkspacePluginSlot: (
      wsId: string,
      workspaceInstance: Workspace["instance"],
      pluginId: string,
      value: unknown,
    ) =>
      dispatch({
        type: "setWorkspacePluginSlot",
        wsId,
        workspaceInstance,
        pluginId,
        value,
      }),
  };
}
