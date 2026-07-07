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
  resolvePaneProvisioning,
  revivePane,
  setPaneAutoTitle,
  setPaneProvisioningError,
  setPaneProvisioningPhase,
  setPaneSession,
  setWorkspacePluginSlot,
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
  /** Dock open per workspace id (absent = closed). Session-only by
   * decision — the codec never writes it, so every launch starts closed. */
  dockByWs: Record<string, boolean>;
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
  /** Flip a workspace's dock (the top bar's dock button). */
  | { type: "toggleDock"; wsId: string }
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
    }
  /** A background worktree create landed: pin the pane to it and mount its
   * terminal. */
  | {
      type: "resolvePaneProvisioning";
      wsId: string;
      paneId: string;
      cwd: string;
      branch: string;
    }
  /** Record why a pane's worktree create failed, or clear it (`null`) when a
   * Retry starts. */
  | {
      type: "setPaneProvisioningError";
      wsId: string;
      paneId: string;
      error: string | null;
    }
  /** The provisioning card's step: the worktree exists, setup is running. */
  | { type: "setPaneProvisioningPhase"; wsId: string; paneId: string; phase: "setup" }
  /** Set (or, via `undefined`, clear) one plugin's opaque persisted slot for
   * a workspace — the write path behind a plugin's workspace-scoped storage
   * (`ctx.storage.workspace(wsId)`). */
  | {
      type: "setWorkspacePluginSlot";
      wsId: string;
      pluginId: string;
      value: unknown;
    };

export const initialDeckState: DeckState = {
  workspaces: [],
  activeId: "",
  focusByWs: {},
  selectByWs: {},
  dockByWs: {},
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
function dropKey<T>(
  map: Record<string, T>,
  key: string,
): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** Rebuild deck state around a workspaces transform, but only when it actually
 * changed the array: a transform that returns the same ref (a no-op — a
 * same-value rebind, a repeated OSC title, a closed pane's late result) yields
 * the same state ref, so a re-fired effect causes no re-render. */
function withWorkspaces(state: DeckState, workspaces: Workspace[]): DeckState {
  return workspaces === state.workspaces ? state : { ...state, workspaces };
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
      if (!appended) return { ...state, workspaces };
      return {
        ...state,
        workspaces,
        selectByWs: { ...state.selectByWs, [action.id]: action.pane.id },
        // A pre-existing maximize would leave the appended pane collapsed and
        // invisible (resolveFocus still points at the old pane). Exit fullscreen
        // on append so the new pane shows — the mirror of closeAgent's guard.
        focusByWs: dropKey(state.focusByWs, action.id),
      };
    }
    case "renameWorkspace":
      return {
        ...state,
        workspaces: renameWorkspace(state.workspaces, action.id, action.name),
      };
    case "moveWorkspace":
      // moveWorkspace returns the same ref on a no-op move → skip the re-render.
      return withWorkspaces(
        state,
        moveWorkspace(state.workspaces, action.id, action.toIndex),
      );
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
      const dockByWs = dropKey(state.dockByWs, action.id);
      const newActive = workspaces.find((w) => w.id === activeId);
      const selectByWs = withDefaultSelection(
        dropKey(state.selectByWs, action.id),
        activeId,
        newActive,
      );
      return { workspaces, activeId, focusByWs, selectByWs, dockByWs };
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
    case "toggleDock": {
      const dockByWs = state.dockByWs[action.wsId]
        ? dropKey(state.dockByWs, action.wsId)
        : { ...state.dockByWs, [action.wsId]: true };
      return { ...state, dockByWs };
    }
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
    case "setPaneAutoTitle":
      // The helper is a no-op (same array ref) for an unchanged/absent pane.
      return withWorkspaces(
        state,
        setPaneAutoTitle(state.workspaces, action.wsId, action.paneId, action.title),
      );
    case "hydrate":
      return action.state;
    case "revivePane":
      // revivePane returns the same ref for an absent/already-live pane, so a
      // re-fired revive effect causes no re-render.
      return withWorkspaces(
        state,
        revivePane(state.workspaces, action.wsId, action.paneId),
      );
    case "resetPaneLocation":
      return withWorkspaces(
        state,
        resetPaneLocation(state.workspaces, action.wsId, action.paneId),
      );
    case "setPaneSession":
      // Same-id rebinds return the same ref — binding refreshes are no-ops.
      return withWorkspaces(
        state,
        setPaneSession(state.workspaces, action.wsId, action.paneId, action.session),
      );
    case "resolvePaneProvisioning":
      // Same ref when the pane was closed mid-create — the late result of a
      // background create must not resurrect anything.
      return withWorkspaces(
        state,
        resolvePaneProvisioning(state.workspaces, action.wsId, action.paneId, {
          cwd: action.cwd,
          branch: action.branch,
        }),
      );
    case "setPaneProvisioningError":
      return withWorkspaces(
        state,
        setPaneProvisioningError(
          state.workspaces,
          action.wsId,
          action.paneId,
          action.error,
        ),
      );
    case "setPaneProvisioningPhase":
      return withWorkspaces(
        state,
        setPaneProvisioningPhase(
          state.workspaces,
          action.wsId,
          action.paneId,
          action.phase,
        ),
      );
    case "setWorkspacePluginSlot":
      return withWorkspaces(
        state,
        setWorkspacePluginSlot(
          state.workspaces,
          action.wsId,
          action.pluginId,
          action.value,
        ),
      );
  }
}
