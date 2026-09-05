import type { Workspace } from "./workspaces";

/** One workspace's sparse persisted and session-only UI state. */
export interface WorkspaceView {
  focus?: string;
  select?: string;
  dock?: boolean;
  dockTab?: string;
  /** Manual minimize placement. Ignored by List layout. */
  minimized?: string[];
  /** Placement produced by suspend-to-tray. Applies in either layout. */
  suspendedTray?: string[];
}

export type WorkspaceViewMap = Record<string, WorkspaceView>;
type HiddenViewField = "minimized" | "suspendedTray";

function isEmptyView(view: WorkspaceView): boolean {
  return (
    view.focus === undefined &&
    view.select === undefined &&
    view.dock === undefined &&
    view.dockTab === undefined &&
    view.minimized === undefined &&
    view.suspendedTray === undefined
  );
}

/** Set one sparse field while preserving identity for a no-op. */
export function setViewField<K extends keyof WorkspaceView>(
  viewByWs: WorkspaceViewMap,
  wsId: string,
  field: K,
  value: WorkspaceView[K] | undefined,
): WorkspaceViewMap {
  const current = viewByWs[wsId];
  if ((current?.[field] ?? undefined) === value) return viewByWs;
  const next: WorkspaceView = { ...current };
  if (value === undefined) delete next[field];
  else next[field] = value;
  if (isEmptyView(next)) {
    const { [wsId]: _emptied, ...rest } = viewByWs;
    return rest;
  }
  return { ...viewByWs, [wsId]: next };
}

/** Add a pane to one hidden-placement set and move selection off hidden panes. */
export function hidePaneView(
  viewByWs: WorkspaceViewMap,
  workspaces: Workspace[],
  wsId: string,
  paneId: string,
  field: HiddenViewField,
): WorkspaceViewMap {
  const view = viewByWs[wsId];
  const current = view?.[field] ?? [];
  const next = current.includes(paneId) ? current : [...current, paneId];
  let result =
    next === current ? viewByWs : setViewField(viewByWs, wsId, field, next);
  if (view?.focus === paneId) {
    result = setViewField(result, wsId, "focus", undefined);
  }
  const selected = view?.select;
  // Both placements hide a pane from the grid, so selection is repaired
  // against their union — the set this pane just joined, and the other one.
  const hidden = new Set([
    ...next,
    ...(field === "minimized"
      ? (view?.suspendedTray ?? [])
      : (view?.minimized ?? [])),
  ]);
  if (selected !== undefined && hidden.has(selected)) {
    const workspace = workspaces.find((candidate) => candidate.id === wsId);
    const firstVisible = workspace?.panes.find((pane) => !hidden.has(pane.id))?.id;
    result = setViewField(result, wsId, "select", firstVisible);
  }
  return result;
}

export function withDefaultSelection(
  viewByWs: WorkspaceViewMap,
  wsId: string,
  workspace: Workspace | undefined,
): WorkspaceViewMap {
  const first = workspace?.panes[0]?.id;
  if (viewByWs[wsId]?.select || !first) return viewByWs;
  return setViewField(viewByWs, wsId, "select", first);
}
