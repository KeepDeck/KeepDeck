/**
 * The team transforms: one workspace list in, the next one out.
 *
 * Pure and total like the pane transforms: an unknown workspace or pane
 * leaves the list untouched, and a change that changes nothing returns the
 * SAME array so nothing re-renders.
 */
import type { Workspace } from "../workspaces";
import { findTeam, findTeamByName, membersOf, nextTeamSeq } from "./collection";
import { teamId, type Team, type TeamAssignment } from "./model";

/** Apply a team-list transform to the workspace with `id`, leaving the rest
 * as-is — the team-side twin of `mapWorkspace`. An emptied list leaves the
 * key off the workspace, so the sparse shape survives every edit. */
export function mapWorkspaceTeams(
  workspaces: Workspace[],
  id: string,
  transform: (teams: readonly Team[]) => readonly Team[],
): Workspace[] {
  return workspaces.map((ws) => {
    if (ws.id !== id) return ws;
    const next = transform(ws.teams ?? []);
    if (next === ws.teams) return ws;
    if (next.length === 0) {
      const { teams: _none, ...rest } = ws;
      return rest;
    }
    return { ...ws, teams: [...next] };
  });
}

/** Add a team to a workspace. A team whose id the workspace already holds is
 * not added twice — the SAME array comes back. */
export function addTeam(
  workspaces: Workspace[],
  workspaceId: string,
  team: Team,
): Workspace[] {
  return mapWorkspaceTeams(workspaces, workspaceId, (teams) =>
    teams.some((existing) => existing.id === team.id) ? teams : [...teams, team],
  );
}

/**
 * Put a pane on a team spoken by NAME, under a role — or take it off its team
 * (`null`).
 *
 * The one place a name becomes a team: a name nobody holds becomes a new
 * team (minted `team-N` from the whole deck, the name kept as written), and
 * a name somebody holds is that team. Validation is NOT here: whether the
 * role is free and the roster is a valid shape is a question about the whole
 * workspace and belongs to `planTeam`, which every caller runs first. This
 * applies a settled decision.
 *
 * A team that exists only as a roster — no directory of its own — is the set
 * of panes holding it, so the last member leaving takes the team with it: a
 * roster-only team with nobody on it is a name nobody can be addressed by. A
 * team that owns a directory stays, empty or not; the directory is what it
 * is for.
 */
export function assignPaneTeam(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  assignment: TeamAssignment | null,
): Workspace[] {
  const ws = workspaces.find((candidate) => candidate.id === workspaceId);
  const pane = ws?.panes.find((candidate) => candidate.id === paneId);
  if (!ws || !pane) return workspaces;

  const before = pane.team;
  if (assignment === null) {
    if (!before) return workspaces;
    return pruneRosterOnly(
      withMembership(workspaces, workspaceId, paneId, undefined),
      workspaceId,
      before.teamId,
    );
  }

  const existing = findTeamByName(ws, assignment.name);
  const team: Team = existing ?? {
    id: teamId(nextTeamSeq(workspaces)),
    name: assignment.name,
  };
  if (before?.teamId === team.id && before.role === assignment.role) {
    return workspaces;
  }
  let next = existing ? workspaces : addTeam(workspaces, workspaceId, team);
  next = withMembership(next, workspaceId, paneId, {
    teamId: team.id,
    role: assignment.role,
  });
  return before && before.teamId !== team.id
    ? pruneRosterOnly(next, workspaceId, before.teamId)
    : next;
}

/** Write (or delete) one pane's membership. Deleted rather than set to
 * undefined: the pane is serialized, and a key holding `undefined` is a key
 * the round-trip has to think about. */
function withMembership(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  team: { teamId: string; role: string } | undefined,
): Workspace[] {
  return workspaces.map((ws) =>
    ws.id === workspaceId
      ? {
          ...ws,
          panes: ws.panes.map((p) => {
            if (p.id !== paneId) return p;
            const { team: _dropped, ...rest } = p;
            return team ? { ...rest, team } : rest;
          }),
        }
      : ws,
  );
}

/** Drop team `teamId` when it is roster-only and nobody is left on it. */
function pruneRosterOnly(
  workspaces: Workspace[],
  workspaceId: string,
  teamId: string,
): Workspace[] {
  const ws = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!ws) return workspaces;
  const team = findTeam(ws, teamId);
  if (!team || team.location !== undefined || membersOf(ws, teamId).length > 0) {
    return workspaces;
  }
  return mapWorkspaceTeams(workspaces, workspaceId, (teams) =>
    teams.filter((candidate) => candidate.id !== teamId),
  );
}
