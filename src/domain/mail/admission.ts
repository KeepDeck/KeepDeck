/**
 * Admitting a member to a team under a role — ONE rule, answered once.
 *
 * A role is an ADDRESS: known to the catalog, so its holder has a charter to
 * be briefed with, and unique on its team, so a message to it reaches one
 * pane. Every door onto a team asks this — the dialog, `team.add`,
 * `agent.spawn`, a relocation — and the deck's reducer applies the answer
 * without judging it again.
 *
 * The policy, said once. A role is always ASKED FOR, and honoured or
 * refused, never quietly replaced: a caller that asked for `impl-1` and was
 * handed `impl-2` under "created" was told a lie, and the person who picked
 * the role in a dialog was overruled in silence. A landing that names no
 * role is refused — nothing picks a role for a member — and so is one the
 * team's shape cannot take ([`rosterProblem`]).
 *
 * It used to be decided four times, with three answers — the command threw,
 * the plan refused, the landing substituted, the reducer wrote nothing — and
 * which one a caller met depended on the door it came through.
 */
import { membersOf, roleTaken, type Workspace } from "../deck";
import {
  leadRole,
  mintRoleAddress,
  parseRoleAddress,
  peerRole,
  roleById,
  teamRoles,
  type RoleStanding,
  type TeamRole,
} from "./roles";

/** Why a role cannot be taken: none was named, it is held, the catalog
 * has no such role, or the team's shape cannot take it. */
export type RoleRefusal = "missing" | "taken" | "unknown" | "misfit";

export type RoleAdmission =
  | { ok: true; role: string }
  /** `open`: the addresses the team would take instead ([`rolesOpenTo`]),
   * so a refusal can say what would be admitted. */
  | { ok: false; why: RoleRefusal; role: string; open: string[] };

const refusal = (why: RoleRefusal, role: string, held: readonly string[]): RoleAdmission => ({
  ok: false,
  why,
  role,
  open: rolesOpenTo(held).map(({ address }) => address),
});

/**
 * The role `asked` for on team `teamId` when it may be taken, else the
 * refusal — asked for nothing included. An address (`impl-2`) is honoured
 * as it is; a repeatable ROLE (`impl`) asks for any member of it, and takes
 * its next free address. `except` is a pane whose own current role does not
 * count as held — the pane being moved onto the team.
 */
export function admitRole(
  workspace: Workspace,
  teamId: string,
  asked: string | undefined,
  except?: string,
): RoleAdmission {
  const held = rolesOnTeam(workspace, teamId, except);
  const trimmed = asked?.trim();
  if (!trimmed) return refusal("missing", "", held);
  const repeatable = roleById(trimmed.toLowerCase());
  const wanted = repeatable?.repeatable ? (mintRoleAddress(repeatable, held) ?? trimmed) : trimmed;
  if (!parseRoleAddress(wanted)) return refusal("unknown", wanted, held);
  if (roleTaken(workspace, teamId, wanted, except)) return refusal("taken", wanted, held);
  // The team as it would be with the newcomer on it: the same grammar the
  // roster's own settling asks, so no door lets in a shape another refuses.
  if (rosterProblem([...held, wanted]) !== null) return refusal("misfit", wanted, held);
  return { ok: true, role: wanted };
}

/**
 * The role a member keeps when it is MOVED onto team `teamId` — nobody is
 * there to ask, so it is the role the person gave it: the same address
 * while that is free, the next free number of the same role when only the
 * number is taken (impl-1 lands as impl-2). A singleton already held, or a
 * role the team's shape refuses, cannot be carried: the move is refused,
 * and the person picks. `except` is the pane being moved.
 */
export function carryRole(
  workspace: Workspace,
  teamId: string,
  role: string | undefined,
  except: string,
): RoleAdmission {
  return carryRoleInto(rolesOnTeam(workspace, teamId, except), role);
}

/** [`carryRole`] against a roster given as its addresses — for a team the
 * move would mint, which holds nobody yet. */
export function carryRoleInto(held: readonly string[], role: string | undefined): RoleAdmission {
  // A pane on no team was never given a role, and none is made up for it.
  if (!role) return refusal("missing", "", held);
  const known = parseRoleAddress(role);
  if (!known) return refusal("unknown", role, held);
  const taken = held.some((address) => address.toLowerCase() === role.trim().toLowerCase());
  const address = taken ? mintRoleAddress(known.role, held) : role;
  if (address === null) return refusal("taken", role, held);
  if (rosterProblem([...held, address]) !== null) return refusal("misfit", role, held);
  return { ok: true, role: address };
}

/** The addresses team `teamId` holds — but for `except`, a pane moving. */
export function rolesOnTeam(workspace: Workspace, teamId: string, except?: string): string[] {
  return membersOf(workspace, teamId)
    .filter((member) => member.id !== except)
    .flatMap((member) => (member.team ? [member.team.role] : []));
}

/** The refusal in words — the same words whichever door asked — and,
 * given the team's `open` addresses, what it would take instead. */
export function roleRefusalMessage(why: RoleRefusal, role: string, open?: readonly string[]): string {
  const base = refusalWords(why, role);
  if (open === undefined) return base;
  return open.length > 0
    ? `${base}; this team is open to ${open.join(", ")}`
    : `${base}; no role can join this team as its roster stands`;
}

function refusalWords(why: RoleRefusal, role: string): string {
  switch (why) {
    case "missing":
      return "a member joins a team under a role somebody names";
    case "taken":
      return `role "${role}" is taken on that team — a role is an address, so it has to be unique`;
    case "unknown":
      return `"${role}" is not a role this deck knows`;
    case "misfit":
      return `role "${role}" does not fit that team — a team is led (one lead, the working roles under it) or flat (peers only)`;
  }
}

/**
 * What is wrong with a team whose members answer to `roles`, or null when
 * nothing is — THE shape of a team, said once.
 *
 * A role is an address, so none repeats; it is the catalog's, so an unknown
 * one has no charter to brief its holder with. And a team has one of two
 * shapes, which the roster itself says: LED — one lead handing out work to
 * members whose charters name it — or FLAT, peers only, where nobody
 * assigns anything. An EMPTY roster is neither: a team with nobody on it
 * yet, whose card stays until someone joins.
 *
 * `planTeam` asks it of a whole roster being settled; a landing asks it of
 * the roster the team would have with the newcomer on it — one grammar, so
 * a shape one door refuses cannot come in through another.
 */
export function rosterProblem(roles: readonly string[]): string | null {
  const seen = new Set<string>();
  const standings: Record<RoleStanding, number> = { leads: 0, reports: 0, peer: 0 };
  for (const role of roles) {
    const key = role.toLowerCase();
    if (seen.has(key)) {
      return `two members share the role "${role}" — a role is an address, so it has to be unique`;
    }
    seen.add(key);
    const known = parseRoleAddress(role);
    if (!known) return roleRefusalMessage("unknown", role);
    standings[known.role.standing] += 1;
  }
  if (standings.peer > 0 && (standings.leads > 0 || standings.reports > 0)) {
    return `a team is either led or flat: ${peerRole().id}s stand only with ${peerRole().id}s`;
  }
  // No "one lead" count: the lead is a singleton address, so a second one
  // is the repeated address refused above.
  // A working role's charter takes direction from the lead, so without one
  // every member would be briefed to follow a role that is not there.
  if (standings.reports > 0 && standings.leads === 0) {
    return `a team needs one ${leadRole().id} — it is the member that hands out the work`;
  }
  return null;
}

/** A role a team can take next, and the address it would take it under. */
export interface OpenRole {
  role: TeamRole;
  address: string;
}

/**
 * The roles a team holding `held` can take its NEXT member under, in
 * catalog order, each with the address it would be minted as. Only what
 * `rosterProblem` accepts: an empty team is offered a lead or a peer, a led
 * team its working roles (never a second lead, never a peer), a flat team
 * another peer. What a picker offers and what the landing admits are
 * therefore the same answer.
 */
export function rolesOpenTo(held: readonly string[]): OpenRole[] {
  return teamRoles().flatMap((role) => {
    const address = mintRoleAddress(role, held);
    if (address === null || rosterProblem([...held, address]) !== null) return [];
    return [{ role, address }];
  });
}
