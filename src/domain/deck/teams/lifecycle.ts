/**
 * A team's life: born with a directory (or a create heading for one),
 * renamed, joined and left, dissolved.
 *
 * Every transform is pure and total — an unknown workspace, team or pane,
 * and a change the rules refuse, leave the list untouched and return the
 * SAME array. The refusals are also asked as questions ([`teamNameTaken`])
 * so a surface can say WHY before it dispatches; the transform still refuses
 * on its own, because an agent driving a command reads no surface.
 *
 * What a transform here does NOT do: touch a directory on disk, end an
 * agent, or judge whether a directory is free. Who holds a folder is the
 * lifecycle machine's to know; it refuses a held place before a team is
 * ever written here.
 */
import { MAX_PANES } from "../layout";
import type { Workspace } from "../workspaces";
import { findTeam, findTeamByName, membersOf, teamsOf } from "./collection";
import { autoTeamName, type Team, type TeamLocation } from "./model";
import { mapWorkspaceTeams, setMembership } from "./transforms";

/**
 * The auto name for a team in `ws`: "Team N" for the first N, counting on
 * from how many teams the workspace has, that no other team there holds.
 * Read from the names, never from ids: an id is a random token and says
 * nothing about how many teams came before. `except` is a team being
 * renamed, whose own name does not count against it.
 */
export function nextAutoTeamName(ws: Workspace, except?: string): string {
  let n = teamsOf(ws).filter((team) => team.id !== except).length + 1;
  while (teamNameTaken(ws, autoTeamName(n), except)) n += 1;
  return autoTeamName(n);
}

/** The name of a team made to land a new member: the one asked for while
 * no team in `ws` holds it, else the next auto name. A taken name is never
 * a way onto the team holding it, nor a second team under it. */
export function landingTeamName(ws: Workspace, asked: string | undefined): string {
  const name = asked?.trim();
  return name && !teamNameTaken(ws, name) ? name : nextAutoTeamName(ws);
}

/** Whether `name` is held by a team in the workspace other than `except`. */
export function teamNameTaken(
  ws: Workspace,
  name: string,
  except?: string,
): boolean {
  const holder = findTeamByName(ws, name);
  return holder !== undefined && holder.id !== except;
}

/**
 * Create a team that owns (or is about to own) a directory — the deck's
 * write of a team the lifecycle machine has already given its id and its
 * place. Refused, with the SAME array back: an id already in use, a name
 * some team holds (by key), or a blank name — the person is told by
 * [`teamNameTaken`] before ever reaching this.
 */
export function createTeam(
  workspaces: Workspace[],
  workspaceId: string,
  team: Team & { location: TeamLocation },
): Workspace[] {
  const ws = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!ws) return workspaces;
  if (!team.name.trim()) return workspaces;
  if (findTeam(ws, team.id) || teamNameTaken(ws, team.name)) return workspaces;
  return mapWorkspaceTeams(workspaces, workspaceId, (teams) => [...teams, team]);
}

/** The team's background worktree create landed: pin it to the created
 * directory and drop the card. SAME array for a gone team or one that was
 * not provisioning. */
export function resolveTeamProvisioning(
  workspaces: Workspace[],
  workspaceId: string,
  teamId: string,
  worktree: { cwd: string; branch: string },
): Workspace[] {
  const ws = workspaces.find((candidate) => candidate.id === workspaceId);
  const team = ws ? findTeam(ws, teamId) : undefined;
  if (!team || team.location?.kind !== "provisioning") return workspaces;
  return mapWorkspaceTeams(workspaces, workspaceId, (teams) =>
    teams.map((candidate) =>
      candidate.id === teamId
        ? {
            ...candidate,
            location: { kind: "attached", cwd: worktree.cwd, branch: worktree.branch },
          }
        : candidate,
    ),
  );
}

/** Record why a team's worktree create failed — the card flips to failed —
 * or clear it (`null`) when a Retry starts. SAME array for a gone or
 * non-provisioning team and when the error already equals the target. */
export function setTeamProvisioningError(
  workspaces: Workspace[],
  workspaceId: string,
  teamId: string,
  error: string | null,
): Workspace[] {
  const ws = workspaces.find((candidate) => candidate.id === workspaceId);
  const team = ws ? findTeam(ws, teamId) : undefined;
  const card = team?.location?.kind === "provisioning" ? team.location : null;
  if (!card || (card.error ?? null) === error) return workspaces;
  const { error: _old, ...rest } = card;
  return mapWorkspaceTeams(workspaces, workspaceId, (teams) =>
    teams.map((candidate) =>
      candidate.id === teamId
        ? { ...candidate, location: error === null ? rest : { ...rest, error } }
        : candidate,
    ),
  );
}

/** Rename a team. Panes are not touched — they hold the id. An empty name
 * reverts to [`autoTeamName`], the reset-on-empty contract `workspaceName`
 * has; a name another team holds is refused with the SAME array. */
export function renameTeam(
  workspaces: Workspace[],
  workspaceId: string,
  teamId: string,
  name: string,
): Workspace[] {
  const ws = workspaces.find((candidate) => candidate.id === workspaceId);
  const team = ws ? findTeam(ws, teamId) : undefined;
  if (!ws || !team) return workspaces;
  const next = name.trim() || nextAutoTeamName(ws, teamId);
  if (next === team.name) return workspaces;
  if (teamNameTaken(ws, next, teamId)) return workspaces;
  return mapWorkspaceTeams(workspaces, workspaceId, (teams) =>
    teams.map((candidate) =>
      candidate.id === teamId ? { ...candidate, name: next } : candidate,
    ),
  );
}

/**
 * Settle a team's roster in ONE step: its name, and each member's role.
 *
 * The one write the roster surfaces make — the dialog and `team.role`
 * both settle a whole roster through `planTeam` and apply it here — so two
 * members swapping roles never pass through a moment in which one address
 * is held twice, and a rename never goes through a pane: the name is an
 * address, the id is the key, and no member moves for it.
 *
 * Refused, with the SAME array: a gone team; a blank name, or one another
 * team holds; a pane not on this team, listed twice, or one of the team's
 * members the roster leaves out — an agent runs where its team runs, so
 * nobody comes off a team here (ending one is the close flow's); a blank
 * or duplicate role. The roster's SHAPE (one lead, no peers among reports)
 * is `planTeam`'s question, asked before this is reached. A roster that
 * changes nothing answers the SAME array too.
 */
export function settleRoster(
  workspaces: Workspace[],
  workspaceId: string,
  teamId: string,
  name: string,
  members: readonly { paneId: string; role: string }[],
): Workspace[] {
  const ws = workspaces.find((candidate) => candidate.id === workspaceId);
  const team = ws ? findTeam(ws, teamId) : undefined;
  if (!ws || !team) return workspaces;
  const next = name.trim();
  if (!next || teamNameTaken(ws, next, teamId)) return workspaces;
  const roster = membersOf(ws, teamId);
  if (roster.length !== members.length) return workspaces;
  const addresses = new Set<string>();
  const roleOf = new Map<string, string>();
  for (const member of members) {
    const address = member.role.trim();
    if (!address || addresses.has(address.toLowerCase())) return workspaces;
    if (roleOf.has(member.paneId)) return workspaces;
    if (!roster.some((pane) => pane.id === member.paneId)) return workspaces;
    addresses.add(address.toLowerCase());
    roleOf.set(member.paneId, address);
  }
  const rolesChange = roster.some((pane) => pane.team?.role !== roleOf.get(pane.id));
  if (next === team.name && !rolesChange) return workspaces;
  const renamed =
    next === team.name
      ? workspaces
      : mapWorkspaceTeams(workspaces, workspaceId, (teams) =>
          teams.map((candidate) =>
            candidate.id === teamId ? { ...candidate, name: next } : candidate,
          ),
        );
  if (!rolesChange) return renamed;
  return renamed.map((candidate) =>
    candidate.id !== workspaceId
      ? candidate
      : {
          ...candidate,
          panes: candidate.panes.map((pane) => {
            const role = roleOf.get(pane.id);
            return role === undefined || pane.team?.role === role
              ? pane
              : { ...pane, team: { teamId, role } };
          }),
        },
  );
}

/** Whether `role` is free on team `teamId` — compared the way addresses are,
 * case-insensitively — for anyone but `except`. */
export function roleTaken(
  ws: Workspace,
  teamId: string,
  role: string,
  except?: string,
): boolean {
  const key = role.trim().toLowerCase();
  return membersOf(ws, teamId).some(
    (pane) => pane.id !== except && pane.team?.role.toLowerCase() === key,
  );
}

/**
 * Put a pane on team `teamId` under `role` — the landing's write, when a
 * pane arrives on a team. Refused, with the SAME array: a gone team, a
 * blank role, a role somebody else on the team holds, or a team already at
 * the cap — the cap is the team's, because the grid the team's panes lay
 * out on is `paneGrid`'s 1..=MAX_PANES. There is no leaving: an agent runs
 * where its team runs, so a pane comes off a team only by closing.
 */
export function joinTeam(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  teamId: string,
  role: string,
): Workspace[] {
  const ws = workspaces.find((candidate) => candidate.id === workspaceId);
  const team = ws ? findTeam(ws, teamId) : undefined;
  const pane = ws?.panes.find((candidate) => candidate.id === paneId);
  if (!ws || !team || !pane) return workspaces;
  const address = role.trim();
  if (!address || roleTaken(ws, teamId, address, paneId)) return workspaces;
  const alreadyOn = pane.team?.teamId === teamId;
  if (!alreadyOn && membersOf(ws, teamId).length >= MAX_PANES) return workspaces;
  return setMembership(workspaces, workspaceId, paneId, { teamId, role: address });
}

/**
 * Remove a team that has nobody on it. A team with members is refused with
 * the SAME array: dissolving one goes through the close flow, which ends or
 * releases the members first and asks about the directory — the two
 * decisions this transform must never make on its own.
 */
export function dissolveTeam(
  workspaces: Workspace[],
  workspaceId: string,
  teamId: string,
): Workspace[] {
  const ws = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!ws || !findTeam(ws, teamId) || membersOf(ws, teamId).length > 0) {
    return workspaces;
  }
  return mapWorkspaceTeams(workspaces, workspaceId, (teams) =>
    teams.filter((candidate) => candidate.id !== teamId),
  );
}
