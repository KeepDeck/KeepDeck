/**
 * The team transforms: one workspace list in, the next one out.
 *
 * Pure and total like the pane transforms: an unknown workspace or pane
 * leaves the list untouched, and a change that changes nothing returns the
 * SAME array so nothing re-renders.
 */
import type { Workspace } from "../workspaces";
import type { Team } from "./model";

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

/**
 * Write (or delete) one pane's membership — by team ID, and the ONE
 * primitive every membership write goes through.
 *
 * It neither finds nor makes a team. Whether `teamId` names a team the
 * workspace has, whether the role is free and whether the team has room are
 * `joinTeam`'s and `settleRoster`'s questions, asked before this is
 * reached. A membership spoken by NAME does not exist here any more: a name
 * is an address, and the one thing that ever minted a team from a name
 * minted a roster with no directory — and a directory is what an agent
 * runs in.
 *
 * Deleted rather than set to undefined: the pane is serialized, and a key
 * holding `undefined` is a key the round-trip has to think about. The SAME
 * array for an unknown workspace or pane, and for a write of what is
 * already there.
 */
export function setMembership(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  team: { teamId: string; role: string } | undefined,
): Workspace[] {
  const ws = workspaces.find((candidate) => candidate.id === workspaceId);
  const pane = ws?.panes.find((candidate) => candidate.id === paneId);
  if (!ws || !pane) return workspaces;
  if (pane.team?.teamId === team?.teamId && pane.team?.role === team?.role) {
    return workspaces;
  }
  return workspaces.map((candidate) =>
    candidate.id !== workspaceId
      ? candidate
      : {
          ...candidate,
          panes: candidate.panes.map((p) => {
            if (p.id !== paneId) return p;
            const { team: _dropped, ...rest } = p;
            return team ? { ...rest, team } : rest;
          }),
        },
  );
}
