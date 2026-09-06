/**
 * A team's life: born with a directory (or a create heading for one),
 * renamed, joined and left, dissolved.
 *
 * Every transform is pure and total — an unknown workspace, team or pane,
 * and a change the rules refuse, leave the list untouched and return the
 * SAME array. The refusals are also asked as questions ([`teamNameTaken`],
 * [`teamOccupyingPath`]) so a surface can say WHY before it dispatches; the
 * transform still refuses on its own, because an agent driving a command
 * reads no surface.
 *
 * What a transform here does NOT do: touch a directory on disk, or end an
 * agent. Dissolving a team removes the object; deleting its worktree and
 * closing its members are the app layer's, ordered there.
 */
import { MAX_PANES } from "../layout";
import type { Workspace } from "../workspaces";
import { findTeam, findTeamByName, membersOf, teamsOf } from "./collection";
import { autoTeamName, type Team, type TeamLocation } from "./model";
import { assignPaneTeam, mapWorkspaceTeams } from "./transforms";

/** The path a team holds for occupancy: the directory it runs in, or the one
 * its create is heading for. A team with no directory yet holds none. */
export function teamHeldPath(team: Pick<Team, "location">): string | undefined {
  const location = team.location;
  if (!location) return undefined;
  return location.kind === "attached" ? location.cwd : location.intent.path;
}

/** Path spelling differences that don't change the directory: surrounding
 * whitespace and trailing slashes. NOT a canonicalizer (no fs access). The
 * ONE rule every "is this the same directory" question asks — occupancy,
 * landing, and the root guard on a deletion target. */
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  const stripped = trimmed.replace(/\/+$/, "");
  return stripped === "" ? trimmed : stripped;
}

/** The team already holding `path`, across every workspace — one directory
 * is one team's, by construction. Null when it is free. */
export function teamOccupyingPath(
  workspaces: readonly Workspace[],
  path: string,
): { ws: Workspace; team: Team } | null {
  const wanted = normalizePath(path);
  if (!wanted) return null;
  for (const ws of workspaces) {
    for (const team of teamsOf(ws)) {
      const held = teamHeldPath(team);
      if (held && normalizePath(held) === wanted) return { ws, team };
    }
  }
  return null;
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
 * Create a team that owns (or is about to own) a directory.
 *
 * The caller mints the id and the name — `teamId(nextTeamSeq(...))` and
 * `autoTeamName(seq)` when the person left it blank — because a dispatch
 * cannot hand an id back, and the app needs it to issue the create behind
 * the card. Refused, with the SAME array back: an id already in use, a name
 * some team holds (by key), a blank name, or a directory some team already
 * holds — the person is told by [`teamNameTaken`] / [`teamOccupyingPath`]
 * before ever reaching this.
 *
 * The workspace ROOT is the one directory every workspace opened on the
 * same repository holds for itself: a team on it in another workspace does
 * not hold it here. A second team on it in THIS workspace is refused like
 * any other doubly-held directory.
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
  const path = teamHeldPath(team);
  if (path) {
    const wanted = normalizePath(path);
    const heldHere = teamsOf(ws).some((candidate) => {
      const held = teamHeldPath(candidate);
      return held !== undefined && normalizePath(held) === wanted;
    });
    if (heldHere) return workspaces;
    const ownRoot = wanted === normalizePath(ws.cwd);
    if (!ownRoot && teamOccupyingPath(workspaces, path)) return workspaces;
  }
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
 * reverts to [`autoTeamName`], the reset-on-empty contract `renameWorkspace`
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
  const seq = /^team-(\d+)$/.exec(teamId);
  const next = name.trim() || (seq ? autoTeamName(Number(seq[1])) : teamId);
  if (next === team.name) return workspaces;
  if (teamNameTaken(ws, next, teamId)) return workspaces;
  return mapWorkspaceTeams(workspaces, workspaceId, (teams) =>
    teams.map((candidate) =>
      candidate.id === teamId ? { ...candidate, name: next } : candidate,
    ),
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
 * Put a pane on team `teamId` under `role`. Refused, with the SAME array: a
 * gone team, a blank role, a role somebody else on the team holds, or a
 * team already at the cap — the cap is the team's, because the grid the
 * team's panes lay out on is `paneGrid`'s 1..=MAX_PANES. A pane moving from
 * another team leaves it as [`assignPaneTeam`] would.
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
  return assignPaneTeam(workspaces, workspaceId, paneId, { name: team.name, role: address });
}

/** Take a pane off its team. What leaving MEANS for the pane's directory —
 * a member runs in the team's directory, so leaving is leaving it, and a
 * session bound there cannot resume elsewhere — arrives with stage C3, when
 * the pane stops carrying a placement of its own; until then the pane keeps
 * the directory it still holds. */
export function leaveTeam(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
): Workspace[] {
  return assignPaneTeam(workspaces, workspaceId, paneId, null);
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
