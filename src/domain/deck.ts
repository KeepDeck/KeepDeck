import { resolveFocus, type Pane, type PaneSession } from "./panes";
import {
  addAgentPane,
  closeAgent,
  closeWorkspace,
  moveWorkspace,
  renamePane,
  renameWorkspace,
  resetPaneLocation,
  resolveActiveId,
  revivePane,
  setPaneAutoTitle,
  setPaneSession,
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
  /** Append an already-formed agent pane (from the add-agent dialog). */
  | { type: "addAgentPane"; id: string; pane: Pane }
  | { type: "renameWorkspace"; id: string; name: string }
  /** Reorder the rail: move workspace `id` to `toIndex` (drag & drop). */
  | { type: "moveWorkspace"; id: string; toIndex: number }
  | { type: "closeAgent"; wsId: string; paneId: string }
  | { type: "closeWorkspace"; id: string }
  | { type: "toggleFocus"; wsId: string; paneId: string }
  | { type: "selectPane"; wsId: string; paneId: string }
  /** Manual pane rename ([F11]); empty name reverts to auto/derived. */
  | { type: "renamePane"; wsId: string; paneId: string; name: string }
  /** Auto title from the terminal (OSC) for a pane ([F11]). */
  | { type: "setPaneAutoTitle"; wsId: string; paneId: string; title: string }
  /** Replace the whole deck with a restored one (app boot, [F7]). */
  | { type: "hydrate"; state: DeckState }
  /** Wake a dormant restored pane — its terminal mounts and spawns ([F7]). */
  | { type: "revivePane"; wsId: string; paneId: string }
  /** Detach a pane from a gone worktree (drops cwd/branch/session) so it can
   * start fresh in the workspace cwd ([F7] restore reconcile). */
  | { type: "resetPaneLocation"; wsId: string; paneId: string }
  /** Bind a live pane to its agent session — the resume key ([F7]/[F8]) —
   * or drop a dead binding (`null`). */
  | {
      type: "setPaneSession";
      wsId: string;
      paneId: string;
      session: PaneSession | null;
    };

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
    case "moveWorkspace": {
      // moveWorkspace returns the same ref on a no-op move → skip the re-render.
      const workspaces = moveWorkspace(state.workspaces, action.id, action.toIndex);
      if (workspaces === state.workspaces) return state;
      return { ...state, workspaces };
    }
    case "closeAgent": {
      const { wsId, paneId } = action;
      const remaining =
        state.workspaces
          .find((w) => w.id === wsId)
          ?.panes.filter((p) => p.id !== paneId) ?? [];
      const workspaces = closeAgent(state.workspaces, wsId, paneId);
      // Drop the maximize key unless it still RESOLVES over the survivors —
      // not only when the maximized pane itself was closed. A key left on a
      // now-solo workspace is masked (solo never maximizes) but springs back
      // on the NEXT added pane, rendering it collapsed and invisible.
      const focused = state.focusByWs[wsId];
      const focusByWs =
        focused !== undefined && resolveFocus(remaining, focused) === null
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
    case "renamePane":
      return {
        ...state,
        workspaces: renamePane(
          state.workspaces,
          action.wsId,
          action.paneId,
          action.name,
        ),
      };
    case "setPaneAutoTitle": {
      // No-op (same state ref → no re-render) when the title is unchanged; the
      // terminal can emit the same OSC title repeatedly.
      const next = action.title.trim() || undefined;
      const pane = state.workspaces
        .find((w) => w.id === action.wsId)
        ?.panes.find((p) => p.id === action.paneId);
      if (!pane || pane.autoTitle === next) return state;
      return {
        ...state,
        workspaces: setPaneAutoTitle(
          state.workspaces,
          action.wsId,
          action.paneId,
          action.title,
        ),
      };
    }
    case "hydrate":
      return action.state;
    case "revivePane": {
      // revivePane returns the same ref for an absent/already-live pane, so a
      // re-fired revive effect causes no re-render.
      const workspaces = revivePane(state.workspaces, action.wsId, action.paneId);
      if (workspaces === state.workspaces) return state;
      return { ...state, workspaces };
    }
    case "resetPaneLocation": {
      const workspaces = resetPaneLocation(
        state.workspaces,
        action.wsId,
        action.paneId,
      );
      if (workspaces === state.workspaces) return state;
      return { ...state, workspaces };
    }
    case "setPaneSession": {
      // Same-id rebinds return the same ref — binding refreshes are no-ops.
      const workspaces = setPaneSession(
        state.workspaces,
        action.wsId,
        action.paneId,
        action.session,
      );
      if (workspaces === state.workspaces) return state;
      return { ...state, workspaces };
    }
  }
}
