import { resolveFocus, type Pane } from "./panes";
import { stagePanes } from "./stage";
import type { Workspace } from "./workspaces";

/** One workspace's sparse persisted and session-only UI state. */
export interface WorkspaceView {
  /** The maximize spotlight of each team, by pane id — at most one per
   * team, so going to another team and back finds the first one as it was
   * left. Written only through `withSpotlight` / `toggledSpotlight`, which
   * keep that one-per-team shape; read through `resolveFocus` over a grid. */
  focus?: readonly string[];
  select?: string;
  dock?: boolean;
  dockTab?: string;
  /** Manual minimize placement. Ignored by List layout. */
  minimized?: string[];
  /** Placement produced by suspend-to-tray. Applies in either layout. */
  suspendedTray?: string[];
  /** The team the stage has open, by id; absent at the cards level. A
   * LEVEL, not a hide reason: the panes of every other team stay mounted
   * and merely are not laid out (`stage.ts`). `select` is always one of
   * the open team's members, or nothing — every writer that repairs it
   * repairs it within the slice. */
  teamOpen?: string;
  /** The epics whose tasks the Tasks list folds away on this workspace's
   * board, by uid — absent, every epic shows its tasks. Written whole by
   * the dialog (`epicFoldsAfter`, which drops the epics the board no
   * longer has); it leaves with the workspace. */
  foldedEpics?: readonly string[];
  /** The stored view's fields this build does not know (a newer
   * revision's) — kept so a save writes them back, never read. */
  extras?: Record<string, unknown>;
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
    view.suspendedTray === undefined &&
    view.teamOpen === undefined &&
    view.foldedEpics === undefined &&
    view.extras === undefined
  );
}

/** The view back at a workspace's team cards: no team open, and nothing
 * highlighted — the cards level has no pane to highlight. The spotlights
 * are kept: each team's comes back when that team is opened again. */
export function backToCards(viewByWs: WorkspaceViewMap, wsId: string): WorkspaceViewMap {
  return setViewField(setViewField(viewByWs, wsId, "teamOpen", undefined), wsId, "select", undefined);
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
  if (view?.focus?.includes(paneId)) {
    const rest = view.focus.filter((id) => id !== paneId);
    result = setViewField(result, wsId, "focus", rest.length > 0 ? rest : undefined);
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
    // ...and within the open team: a pane of another team is not laid out,
    // so it can no more carry the highlight than a hidden one can.
    const workspace = workspaces.find((candidate) => candidate.id === wsId);
    const firstVisible = workspace
      ? stagePanes(workspace, view).find((pane) => !hidden.has(pane.id))?.id
      : undefined;
    result = setViewField(result, wsId, "select", firstVisible);
  }
  return result;
}

/** Give a workspace with no highlight one: the open team's first member.
 * Nothing at the cards level — no pane is in front of the person there. */
export function withDefaultSelection(
  viewByWs: WorkspaceViewMap,
  wsId: string,
  workspace: Workspace | undefined,
): WorkspaceViewMap {
  const first = workspace ? stagePanes(workspace, viewByWs[wsId])[0]?.id : undefined;
  if (viewByWs[wsId]?.select || !first) return viewByWs;
  return setViewField(viewByWs, wsId, "select", first);
}

/** The panes laid out on one grid with `paneId` — its team's members, the
 * panes on no team being one group of their own. Null for no such pane. */
function gridOf(ws: Pick<Workspace, "panes">, paneId: string): Pane[] | null {
  const pane = ws.panes.find((candidate) => candidate.id === paneId);
  if (!pane) return null;
  const teamId = pane.team?.teamId;
  return ws.panes.filter((candidate) => candidate.team?.teamId === teamId);
}

type Spotlights = readonly string[] | undefined;

/** Undefined for no spotlight, and `focus` itself when `next` holds the
 * same ids — so `setViewField` sees a no-op as one. */
function settled(focus: Spotlights, next: readonly string[]): Spotlights {
  if (focus !== undefined && next.length === focus.length && next.every((id, at) => focus[at] === id)) {
    return focus;
  }
  return next.length > 0 ? next : undefined;
}

/** The pane maximized on `paneId`'s grid, or null. */
export function spotlightOn(ws: Pick<Workspace, "panes">, focus: Spotlights, paneId: string): string | null {
  const grid = gridOf(ws, paneId);
  return grid ? resolveFocus(grid, focus) : null;
}

/** `focus` with the spotlight of `paneId`'s grid set to `next`, or dropped
 * when `next` is absent; every other team's is kept. */
export function withSpotlight(
  ws: Pick<Workspace, "panes">,
  focus: Spotlights,
  paneId: string,
  next?: string,
): Spotlights {
  const grid = gridOf(ws, paneId);
  if (!grid) return focus;
  const onGrid = new Set(grid.map((pane) => pane.id));
  const others = (focus ?? []).filter((id) => !onGrid.has(id));
  return settled(focus, next === undefined ? others : [...others, next]);
}

/** The maximize button: `paneId` takes its grid's spotlight, or gives it
 * back when it already holds it. */
export function toggledSpotlight(ws: Pick<Workspace, "panes">, focus: Spotlights, paneId: string): Spotlights {
  const held = focus?.includes(paneId) ?? false;
  return withSpotlight(ws, focus, paneId, held ? undefined : paneId);
}

/** The spotlights that still resolve over `ws`: each names a pane on a grid
 * of more than one, once per grid — a key left on a now-solo team is masked
 * on render but would spring back on the next pane added to it. */
export function liveSpotlights(ws: Pick<Workspace, "panes">, focus: Spotlights): Spotlights {
  if (focus === undefined) return undefined;
  return settled(
    focus,
    focus.filter((id) => {
      const grid = gridOf(ws, id);
      return grid !== null && resolveFocus(grid, focus) === id;
    }),
  );
}
