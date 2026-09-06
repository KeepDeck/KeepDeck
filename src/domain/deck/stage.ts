/**
 * The stage's slice: which of a workspace's panes are laid out.
 *
 * The stage has two levels. With no team open it shows the workspace's
 * teams as cards and lays out no pane at all; with one open
 * (`view.teamOpen`) it lays out that team's members and nothing else.
 * Opening a team is a LEVEL, not a reason a pane is hidden — the maximize
 * spotlight's precedent (`paneVisibility.ts`): every pane of every team
 * stays mounted, and `hiddenBy` / `visiblePanes` / the shelf read the same
 * view over this slice. Everything that asks "which panes are in front of
 * the person" — the selection and its repairs, the hotkeys, the
 * notification probe, the shelf — asks here first, so a level the stage
 * learns is never one a reader forgets.
 */
import type { Pane } from "./panes";
import { findTeam, membersOf } from "./teams/collection";
import type { Team } from "./teams/model";
import type { Workspace } from "./workspaces";
import type { WorkspaceView } from "./workspaceView";

/** The one view field the level is decided from. */
export type StageLevelView = Pick<WorkspaceView, "teamOpen">;

/** The team the stage has open in `ws`, or undefined at the cards level —
 * and for a `teamOpen` naming a team the workspace no longer has, which
 * reads as the cards level rather than as an open nothing. */
export function openTeamOf(
  ws: Pick<Workspace, "teams">,
  view: StageLevelView | undefined,
): Team | undefined {
  return view?.teamOpen === undefined ? undefined : findTeam(ws, view.teamOpen);
}

/** The panes the stage lays out: the open team's members in deck order,
 * none at the cards level. The same array shape `ws.panes` has, so every
 * reader that took the workspace's panes takes this instead. */
export function stagePanes(
  ws: Pick<Workspace, "panes" | "teams">,
  view: StageLevelView | undefined,
): Pane[] {
  const team = openTeamOf(ws, view);
  return team ? membersOf(ws, team.id) : [];
}
