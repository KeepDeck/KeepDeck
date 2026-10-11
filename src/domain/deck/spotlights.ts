/**
 * The maximize spotlights of a workspace (`WorkspaceView.focus`): the pane
 * each team keeps maximized, at most one per team, so going to another team
 * and back finds the first one as it was left. Every writer of the list
 * goes through here, which is what keeps that one-per-team shape; a grid
 * reads its own through `resolveFocus`.
 */
import { sameIds } from "../idList";
import { resolveFocus, type Pane } from "./panes";
import { membersOf } from "./teams/collection";
import type { Workspace } from "./workspaces";

export type Spotlights = readonly string[] | undefined;

/** The grid `paneId` is laid out on: its team's members. Null for a pane
 * the workspace does not have, or one on no team — never laid out, so
 * never maximized. */
function gridOf(ws: Pick<Workspace, "panes">, paneId: string): Pane[] | null {
  const teamId = ws.panes.find((pane) => pane.id === paneId)?.team?.teamId;
  return teamId === undefined ? null : membersOf(ws, teamId);
}

/** Undefined for no spotlight, and `focus` itself when `next` names the
 * same ones — so `setViewField` sees a no-op as one. */
function settled(focus: Spotlights, next: readonly string[]): Spotlights {
  if (focus !== undefined && sameIds(focus, next)) return focus;
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

/** `focus` without `paneId`'s spotlight — a pane taken off the grid holds
 * none — and its teammates' untouched when it held none. */
export function withoutSpotlight(focus: Spotlights, paneId: string): Spotlights {
  return focus === undefined ? undefined : settled(focus, focus.filter((id) => id !== paneId));
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
