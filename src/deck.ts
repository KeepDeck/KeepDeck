import { useReducer } from "react";
import { type Pane } from "./panes";
import {
  addAgent,
  addAgentPane,
  closeAgent,
  closeWorkspace,
  renameWorkspace,
  resolveActiveId,
  type Workspace,
} from "./workspaces";

/**
 * The deck's interdependent state: the workspaces, which one is active, and the
 * maximized / highlighted pane PER workspace. Kept in one reducer so the close
 * transitions clean focus + selection atomically — the App's old hand-rolled
 * "three setStates per close" was the thing that, if one was missed, left the
 * border or maximize pointing at a removed pane ([S1]).
 */
export interface DeckState {
  workspaces: Workspace[];
  activeId: string;
  /** Maximized pane per workspace id. */
  focusByWs: Record<string, string>;
  /** Highlighted (selected) pane per workspace id. */
  selectByWs: Record<string, string>;
}

export type DeckAction =
  | { type: "selectWorkspace"; id: string }
  | { type: "createWorkspace"; workspace: Workspace }
  /** Replace an (empty) workspace's panes — the count-picker start flow. */
  | { type: "setPanes"; id: string; panes: Pane[] }
  /** Append a bare agent pane numbered `seq` (non-worktree mode). */
  | { type: "addAgent"; id: string; seq: number }
  /** Append an already-provisioned agent pane (worktree mode). */
  | { type: "addAgentPane"; id: string; pane: Pane }
  | { type: "renameWorkspace"; id: string; name: string }
  | { type: "closeAgent"; wsId: string; paneId: string }
  | { type: "closeWorkspace"; id: string }
  | { type: "toggleFocus"; wsId: string; paneId: string }
  | { type: "selectPane"; wsId: string; paneId: string };

export const initialDeckState: DeckState = {
  workspaces: [],
  activeId: "",
  focusByWs: {},
  selectByWs: {},
};

/** Default a workspace's selection to its first pane, only if it has none yet. */
function withDefaultSelection(
  selectByWs: Record<string, string>,
  wsId: string,
  ws: Workspace | undefined,
): Record<string, string> {
  const first = ws?.panes[0]?.id;
  if (selectByWs[wsId] || !first) return selectByWs;
  return { ...selectByWs, [wsId]: first };
}

/** Drop `key` from a map, returning the same reference when it's absent. */
function dropKey(
  map: Record<string, string>,
  key: string,
): Record<string, string> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

export function deckReducer(state: DeckState, action: DeckAction): DeckState {
  switch (action.type) {
    case "selectWorkspace": {
      const ws = state.workspaces.find((w) => w.id === action.id);
      return {
        ...state,
        activeId: action.id,
        selectByWs: withDefaultSelection(state.selectByWs, action.id, ws),
      };
    }
    case "createWorkspace": {
      const { workspace } = action;
      return {
        ...state,
        workspaces: [...state.workspaces, workspace],
        activeId: workspace.id,
        selectByWs: withDefaultSelection(
          state.selectByWs,
          workspace.id,
          workspace,
        ),
      };
    }
    case "setPanes": {
      const workspaces = state.workspaces.map((w) =>
        w.id === action.id ? { ...w, panes: action.panes } : w,
      );
      const ws = workspaces.find((w) => w.id === action.id);
      return {
        ...state,
        workspaces,
        selectByWs: withDefaultSelection(state.selectByWs, action.id, ws),
      };
    }
    case "addAgent": {
      const workspaces = addAgent(state.workspaces, action.id, action.seq);
      const ws = workspaces.find((w) => w.id === action.id);
      const added = ws?.panes[ws.panes.length - 1]?.id;
      return {
        ...state,
        workspaces,
        selectByWs: added
          ? { ...state.selectByWs, [action.id]: added }
          : state.selectByWs,
      };
    }
    case "addAgentPane": {
      const workspaces = addAgentPane(state.workspaces, action.id, action.pane);
      // Only select it if it was actually appended (the cap wasn't hit).
      const appended = workspaces
        .find((w) => w.id === action.id)
        ?.panes.some((p) => p.id === action.pane.id);
      return {
        ...state,
        workspaces,
        selectByWs: appended
          ? { ...state.selectByWs, [action.id]: action.pane.id }
          : state.selectByWs,
      };
    }
    case "renameWorkspace":
      return {
        ...state,
        workspaces: renameWorkspace(state.workspaces, action.id, action.name),
      };
    case "closeAgent": {
      const { wsId, paneId } = action;
      const remaining =
        state.workspaces
          .find((w) => w.id === wsId)
          ?.panes.filter((p) => p.id !== paneId) ?? [];
      const workspaces = closeAgent(state.workspaces, wsId, paneId);
      const focusByWs =
        state.focusByWs[wsId] === paneId
          ? dropKey(state.focusByWs, wsId)
          : state.focusByWs;
      let selectByWs = state.selectByWs;
      if (selectByWs[wsId] === paneId) {
        selectByWs = remaining[0]
          ? { ...selectByWs, [wsId]: remaining[0].id }
          : dropKey(selectByWs, wsId);
      }
      return { ...state, workspaces, focusByWs, selectByWs };
    }
    case "closeWorkspace": {
      const workspaces = closeWorkspace(state.workspaces, action.id);
      const activeId = resolveActiveId(workspaces, state.activeId);
      const focusByWs = dropKey(state.focusByWs, action.id);
      const newActive = workspaces.find((w) => w.id === activeId);
      const selectByWs = withDefaultSelection(
        dropKey(state.selectByWs, action.id),
        activeId,
        newActive,
      );
      return { workspaces, activeId, focusByWs, selectByWs };
    }
    case "toggleFocus": {
      const { wsId, paneId } = action;
      const focusByWs =
        state.focusByWs[wsId] === paneId
          ? dropKey(state.focusByWs, wsId)
          : { ...state.focusByWs, [wsId]: paneId };
      return { ...state, focusByWs };
    }
    case "selectPane":
      return {
        ...state,
        selectByWs: { ...state.selectByWs, [action.wsId]: action.paneId },
      };
  }
}

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
    addAgent: (id: string, seq: number) =>
      dispatch({ type: "addAgent", id, seq }),
    addAgentPane: (id: string, pane: Pane) =>
      dispatch({ type: "addAgentPane", id, pane }),
    renameWorkspace: (id: string, name: string) =>
      dispatch({ type: "renameWorkspace", id, name }),
    closeAgent: (wsId: string, paneId: string) =>
      dispatch({ type: "closeAgent", wsId, paneId }),
    closeWorkspace: (id: string) => dispatch({ type: "closeWorkspace", id }),
    toggleFocus: (wsId: string, paneId: string) =>
      dispatch({ type: "toggleFocus", wsId, paneId }),
    selectPane: (wsId: string, paneId: string) =>
      dispatch({ type: "selectPane", wsId, paneId }),
  };
}
