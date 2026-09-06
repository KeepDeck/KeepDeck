/**
 * Questions about a workspace's teams: which team a pane is on, which team a
 * name means, who is on a team, and what the next team is called.
 *
 * Membership is derived from the panes — a pane holds its team's id — so a
 * workspace never carries a member list that could disagree with the panes
 * that actually hold the roles. The team OBJECTS live on the workspace; the
 * roster is a question asked of the panes.
 */
import type { Pane } from "../panes/model";
import type { Workspace } from "../workspaces";
import { teamNameKey, type Team } from "./model";

/** The workspace's teams. Sparse on the workspace like every other optional
 * field, so a workspace with none carries no key; read through this. */
export function teamsOf(ws: Pick<Workspace, "teams">): readonly Team[] {
  return ws.teams ?? [];
}

/** The team with `id`, if the workspace has it. */
export function findTeam(
  ws: Pick<Workspace, "teams">,
  id: string,
): Team | undefined {
  return teamsOf(ws).find((team) => team.id === id);
}

/** The team a person means by `name` — matched by [`teamNameKey`], so "API"
 * finds the team they called "api". */
export function findTeamByName(
  ws: Pick<Workspace, "teams">,
  name: string,
): Team | undefined {
  const key = teamNameKey(name);
  return teamsOf(ws).find((team) => teamNameKey(team.name) === key);
}

/** The team `pane` is on, or undefined for a pane on none — and for a pane
 * whose id names no team the workspace has, which reads as no membership
 * rather than as a member of nothing. */
export function teamOfPane(
  ws: Pick<Workspace, "teams">,
  pane: Pick<Pane, "team">,
): Team | undefined {
  return pane.team ? findTeam(ws, pane.team.teamId) : undefined;
}

/** The name of the team `pane` is on, or undefined. What every badge and
 * roster prints; the one reading of "the team's name" off a pane. */
export function teamNameOf(
  ws: Pick<Workspace, "teams">,
  pane: Pick<Pane, "team">,
): string | undefined {
  return teamOfPane(ws, pane)?.name;
}

/** The panes on team `teamId`, in deck order. */
export function membersOf(
  ws: Pick<Workspace, "panes">,
  teamId: string,
): Pane[] {
  return ws.panes.filter((pane) => pane.team?.teamId === teamId);
}

/** One past the highest `team-N` any workspace holds — the seq the next
 * team is minted with, derived from the live deck rather than counted
 * separately, so there is one source of truth. Ids outside the scheme are
 * skipped rather than rejected: a mint must always produce something. */
export function nextTeamSeq(
  workspaces: readonly Pick<Workspace, "teams">[],
): number {
  let highest = 0;
  for (const ws of workspaces) {
    for (const team of teamsOf(ws)) {
      const match = /^team-(\d+)$/.exec(team.id);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
  }
  return highest + 1;
}
