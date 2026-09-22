/**
 * Teams, as far as mail is concerned: who may be named, and by what name.
 *
 * A team is a grouping INSIDE a workspace, never across one. Mail may cross
 * workspaces, but only by a team's ID (`role@<team id>`) — the one name
 * unique deck-wide and untouched by a rename; everything else a sender can
 * say (a bare role, a team name, a pane title) means its OWN workspace. It
 * exists because "ask impl-1" is what an agent can usefully be told, while
 * "ask the pane titled Claude 3" is a fact about a window.
 *
 * The team itself is the deck's object (`domain/deck/teams`): a pane holds
 * its id, the name lives on the team. Everything here that takes a NAME
 * resolves it through the workspace's teams first, so no two sites compare
 * names to decide membership — the deck answers that once, by id.
 */
import { resolvePaneRef, resolveTeamRef, type Resolved } from "../commands";
import { findTeamInDeck, membersOf, teamOfPane, type Pane, type Team, type Workspace } from "../deck";
import { formatAddress, parseAddress } from "./address";

export { teamNameKey, type TeamAssignment } from "../deck";

// Whether a pane MAY take a role is not answered here, and deliberately not
// answered twice anywhere: `planTeam` settles a whole roster, and every path
// that changes one — the dialog, or an agent driving `team.role` — goes
// through it. A single-assignment checker lived here once and was the weaker
// of the two: it knew about blank names and duplicate addresses but not about
// the lead a team needs, nor about a pane already belonging to another team,
// so a change one door refused went through another.
//
// Nor is membership answered by NAME here any more: a pane holds its team's
// id, the deck's `membersOf`/`teamOfPane` answer by it, and a name reaches a
// team only through `resolveTeamRef`.

/**
 * Resolve who `ref` means, for a message sent by `from`.
 *
 * A teammate's ROLE wins over anything else. That ordering is the point of
 * having roles at all: an agent told "report to lead" must reach the lead
 * even in a workspace where some pane happens to be titled "lead", and a
 * role is the one name a teammate can be sure of — pane titles follow the
 * terminal and change under them.
 *
 * `role@team` reaches a member of ANOTHER team in the workspace by its role
 * — `role@<team id>` is the form a message from that team shows as its
 * sender, so a reply is addressed by copying what was shown; a team's name
 * is read there too, for whoever types one. A bare role is never another team's:
 * two teams both have a lead, and the sender's own is the one it means.
 *
 * Everything else falls through to the ordinary pane reference (id, title,
 * user-given name), so a workspace with no teams keeps working exactly as
 * it did — a title that happens to hold an `@` included, unless a team of
 * that name holds that role: the address wins over the title, the way a
 * role wins over a pane titled like one.
 */
export function resolveMailTarget(
  workspace: Workspace,
  agents: readonly { id: string; label: string }[],
  from: Pane,
  ref: string,
): Resolved<Pane> {
  const named = parseAddress(ref);
  const other = named ? resolveTeamRef(workspace, named.team) : null;
  if (named && other?.ok) return memberByRole(workspace, other.value, named.role);
  const team = teamOfPane(workspace, from);
  if (team) {
    const mate = roleHolder(workspace, team, ref);
    if (mate) return { ok: true, value: mate };
  }
  const fallback = resolvePaneRef(workspace, agents, ref);
  if (fallback.ok) return fallback;
  // An `@` that named no team here, and no pane titled that way either: the
  // team is what was wrong, and its refusal says which.
  if (other && !other.ok) return other;
  if (!team) return fallback;
  // Inside a team the refusal should say what the sender could have said,
  // because "no agent X" sends an agent looking for a window title it was
  // never given.
  const roles = rolesOn(workspace, team, from.id);
  return {
    ok: false,
    message: roles.length
      ? `${fallback.message}; in team "${team.name}" you can write to: ${roles.join(", ")}`
      : fallback.message,
  };
}

/**
 * Who a MESSAGE goes to: [`resolveMailTarget`] in the sender's own
 * workspace first, its precedence untouched — and only when that finds
 * nobody, a `role@<team id>` naming a team in another workspace. Only an id
 * crosses: a team name, a bare role and a pane title are words of the
 * sender's own workspace, and a name matched elsewhere could be anyone's.
 *
 * A sender on no team cannot write across: it is shown by its pane title,
 * which the reader's workspace does not resolve — a letter nobody could
 * answer. Kept apart from `resolveMailTarget`, which `team.role` also asks
 * and which must never leave the caller's workspace.
 */
export function resolveMailRecipient(
  workspaces: readonly Workspace[],
  workspace: Workspace,
  agents: readonly { id: string; label: string }[],
  from: Pane,
  ref: string,
): Resolved<Pane> {
  const own = resolveMailTarget(workspace, agents, from, ref);
  if (own.ok) return own;
  const named = parseAddress(ref);
  const found = named ? findTeamInDeck(workspaces, named.team) : undefined;
  if (!named || !found || found.workspace.id === workspace.id) return own;
  if (!teamOfPane(workspace, from)) {
    return {
      ok: false,
      message: `${ref} is on another workspace, and you are on no team — a reader there could not answer you`,
    };
  }
  return memberByRole(found.workspace, found.team, named.role);
}

/** The member of `team` answering to `role`, however cased. */
function roleHolder(workspace: Workspace, team: Team, role: string): Pane | undefined {
  const needle = role.trim().toLowerCase();
  return membersOf(workspace, team.id).find(
    (pane) => pane.team?.role.toLowerCase() === needle,
  );
}

/** The roles held on `team`, leaving out `except` — the sender's own, which
 * is never an address it could write to. */
function rolesOn(workspace: Workspace, team: Team, except?: string): string[] {
  return membersOf(workspace, team.id)
    .filter((pane) => pane.id !== except)
    .map((pane) => pane.team?.role)
    .filter((role): role is string => Boolean(role));
}

/** A member of another team by role, or the refusal naming the addresses
 * that WOULD reach that team — in the `role@<team id>` form a sender is
 * shown, so one can be copied rather than guessed at. */
function memberByRole(workspace: Workspace, team: Team, role: string): Resolved<Pane> {
  const holder = roleHolder(workspace, team, role);
  if (holder) return { ok: true, value: holder };
  const roles = rolesOn(workspace, team);
  return {
    ok: false,
    message: roles.length
      ? `no "${role}" on team "${team.name}" — you can write to: ${roles
          .map((held) => formatAddress(held, team))
          .join(", ")}`
      : `nobody is on team "${team.name}" yet`,
  };
}

/** How a pane's team reads in the roster: the team's id and name, and the
 * pane's role. Null rather than absent, so the shape does not change with
 * membership — and null for a pane whose id names no team here, which is
 * no membership to anyone reading it. The id is what a caller hands back
 * to `team.add`; the name is what it says out loud. */
export function teamOf(
  workspace: Workspace,
  pane: Pane,
): { id: string; name: string; role: string } | null {
  const team = teamOfPane(workspace, pane);
  return team && pane.team ? { id: team.id, name: team.name, role: pane.team.role } : null;
}
