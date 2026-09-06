/**
 * Fixture help for tests that speak of membership by NAME — the way the
 * dialog and the document do — against a model where a pane holds a team id.
 *
 * A fixture writes `named: { name, role }` on a pane; [`resolveNamedPanes`]
 * turns those into the workspace's teams and the panes' ids through the
 * same transform the deck uses, so a test never hand-mints a team id.
 */
import type { Pane } from "../panes/model";
import type { Workspace } from "../workspaces";
import type { TeamAssignment } from "./model";
import { assignPaneTeam } from "./transforms";

/** A pane as a fixture spells it: membership by name, resolved later. */
export type NamedPane = Pane & { named?: TeamAssignment };

/** The workspace with every `named` membership applied in pane order and
 * the fixture-only field stripped — the shape the deck actually holds. */
export function resolveNamedPanes(ws: Workspace): Workspace {
  const memberships: [string, TeamAssignment][] = [];
  const panes = ws.panes.map((pane) => {
    const { named, ...rest } = pane as NamedPane;
    if (named) memberships.push([pane.id, named]);
    return rest as Pane;
  });
  let list: Workspace[] = [{ ...ws, panes }];
  for (const [paneId, assignment] of memberships) {
    list = assignPaneTeam(list, ws.id, paneId, assignment);
  }
  return list[0];
}
