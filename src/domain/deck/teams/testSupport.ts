/**
 * Fixture help for tests that speak of membership by NAME — the way a
 * fixture reads best — against a model where a pane holds a team id and a
 * team is an object with a directory.
 *
 * A fixture writes `named: { name, role }` on a pane; [`resolveNamedPanes`]
 * turns those into the workspace's teams and the panes' ids. A team the
 * fixture names for the first time is minted HERE, on the workspace root —
 * the fixture's own doing, never the deck's: the deck has no way from a
 * name to a team, and never makes one from a name.
 */
import type { Pane } from "../panes/model";
import type { Workspace } from "../workspaces";
import { findTeamByName, nextTeamSeq } from "./collection";
import { teamId, type Team, type TeamAssignment } from "./model";
import { mapWorkspaceTeams, setMembership } from "./transforms";

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
    let team = findTeamByName(list[0], assignment.name);
    if (!team) {
      const minted: Team = {
        id: teamId(nextTeamSeq(list)),
        name: assignment.name,
        location: { kind: "attached", cwd: ws.cwd },
      };
      list = mapWorkspaceTeams(list, ws.id, (teams) => [...teams, minted]);
      team = minted;
    }
    list = setMembership(list, ws.id, paneId, { teamId: team.id, role: assignment.role });
  }
  return list[0];
}
