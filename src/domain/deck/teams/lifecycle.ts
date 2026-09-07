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
import { mapWorkspaceTeams, setMembership } from "./transforms";

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

/** Whether a team's own worktree create is still RUNNING — the single
 * question behind "nothing is in that directory yet" and "this card will
 * leave a directory the close cannot name". A card carrying an `error` is
 * NOT still out: it is parked waiting for Retry (or restored that way after
 * a quit), so counting it promises a directory that does not exist and tells
 * the person to wait for something that will never happen. */
export function createIsOut(location: TeamLocation | undefined): boolean {
  return location?.kind === "provisioning" && !location.error;
}

/**
 * Who is in a directory — the FACT, not the verdict.
 *
 * The verdict differs by door, and belongs to the door: a team asking to be
 * BORN here may share the directory when the person says so ([`birthRefusal`]),
 * while a pane asking to LAND here simply joins the team that is in it. One
 * fact, two policies — merging them cost a release the ability to put a pane
 * on a team whose worktree was still being created.
 *
 * `team`/`ws` name the FIRST holder, this workspace's before any other — the
 * one a pane would join. `creating` is true when ANY holder at that path has
 * a create still out, because that fact is about the directory rather than
 * about whichever team happens to sit first in the list.
 *
 * The workspace ROOT is the one directory every workspace opened on the same
 * repository holds for itself, so a team on it in ANOTHER workspace is not a
 * claim here. A team on it in this one is, like any other directory.
 */
export type DirectoryClaim =
  | { kind: "free" }
  | { kind: "held"; ws: Workspace; team: Team; creating: boolean };

export function claimDirectory(
  workspaces: readonly Workspace[],
  /** The workspace asking — its own teams answer first, and its root is its
   * own however many other workspaces hold the same repository. */
  ws: Workspace,
  placement: TeamLocation,
): DirectoryClaim {
  return claimPath(workspaces, ws, teamHeldPath({ location: placement }) ?? "");
}

/** The same fact for a bare PATH — what a surface holding a directory and no
 * placement yet asks. The placement never changed the answer: [`claimDirectory`]
 * only ever read the path out of it, and inventing a placement to ask this
 * question is how a form came to ask about one thing and submit another. */
export function claimPath(
  workspaces: readonly Workspace[],
  ws: Workspace,
  path: string,
): DirectoryClaim {
  const wanted = normalizePath(path);
  if (!wanted) return { kind: "free" };
  const holds = (candidate: Team): boolean => {
    const held = teamHeldPath(candidate);
    return held !== undefined && normalizePath(held) === wanted;
  };
  const claimants = (from: Workspace) =>
    teamsOf(from)
      .filter(holds)
      .map((team) => ({ ws: from, team }));
  const holders = [
    ...claimants(ws),
    ...(wanted === normalizePath(ws.cwd)
      ? []
      : workspaces.filter((other) => other.id !== ws.id).flatMap(claimants)),
  ];
  const first = holders[0];
  if (!first) return { kind: "free" };
  return {
    kind: "held",
    ...first,
    creating: holders.some((held) => createIsOut(held.team.location)),
  };
}

/**
 * Whether a team may be BORN at `placement` — the birth policy, one home,
 * asked by the transform below and by the app's outcome builder alike.
 *
 * `"busy"` — nothing consent can buy: a create is heading for the directory
 * on one side of the question or the other, and git makes no second worktree
 * on one path. `"unshared"` — a team works there and nobody has said to share
 * it yet; the surfaces turn this into a question. `null` — go ahead.
 */
export function birthRefusal(
  claim: DirectoryClaim,
  placement: TeamLocation,
  /** The person (or agent) has answered "create anyway". */
  shared: boolean,
): "busy" | "unshared" | null {
  if (claim.kind === "free") return null;
  if (placement.kind === "provisioning" || claim.creating) return "busy";
  return shared ? null : "unshared";
}

/**
 * The directories teams are STILL working in once `ending` — teams of the
 * workspace `wsId` — are gone. What a close must leave alone: teams share a
 * directory, so a close is not always the last one out, and a worktree
 * somebody still works in outlives it. Read across every workspace, since
 * sharing crosses them too.
 */
export function directoriesStillHeld(
  workspaces: readonly Workspace[],
  wsId: string,
  ending: readonly string[],
): Set<string> {
  const leaving = new Set(ending);
  const kept = new Set<string>();
  for (const ws of workspaces) {
    for (const team of teamsOf(ws)) {
      // Only that workspace's teams are ending; the same id elsewhere is a
      // different team, and it keeps its directory.
      if (ws.id === wsId && leaving.has(team.id)) continue;
      const held = teamHeldPath(team);
      if (held !== undefined) kept.add(normalizePath(held));
    }
  }
  return kept;
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
 * any other doubly-held directory — UNLESS the caller passes `shared`.
 *
 * `shared` is the person's answered consent ("create anyway"), and it lifts
 * exactly one refusal — [`birthRefusal`]'s `"unshared"`, a directory teams
 * already WORK in. What that function calls `"busy"` refuses whatever the
 * caller says.
 */
export function createTeam(
  workspaces: Workspace[],
  workspaceId: string,
  team: Team & { location: TeamLocation },
  options: { shared?: boolean } = {},
): Workspace[] {
  const ws = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!ws) return workspaces;
  if (!team.name.trim()) return workspaces;
  if (findTeam(ws, team.id) || teamNameTaken(ws, team.name)) return workspaces;
  const claim = claimDirectory(workspaces, ws, team.location);
  if (birthRefusal(claim, team.location, options.shared === true)) return workspaces;
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

/**
 * Settle a team's roster in ONE step: its name, and each member's role.
 *
 * The one write the roster surfaces make — the dialog and `team.assign`
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
