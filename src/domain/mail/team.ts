/**
 * Teams, as far as mail is concerned: who may be named, and by what name.
 *
 * A team is a grouping INSIDE a workspace, never across one — the workspace
 * stays the hard boundary, and a team only narrows addressing within it. It
 * exists because "ask impl-1" is what an agent can usefully be told, while
 * "ask the pane titled Claude 3" is a fact about a window.
 *
 * The team itself is the deck's object (`domain/deck/teams`): a pane holds
 * its id, the name lives on the team. Everything here that takes a NAME
 * resolves it through the workspace's teams first, so no two sites compare
 * names to decide membership — the deck answers that once, by id.
 */
import { resolvePaneRef, type Resolved } from "../commands";
import {
  findTeamByName,
  membersOf,
  teamOfPane,
  type Pane,
  type Workspace,
} from "../deck";

export { teamNameKey, type TeamAssignment } from "../deck";

// Whether a pane MAY take a role is not answered here, and deliberately not
// answered twice anywhere: `planTeam` settles a whole roster, and every path
// that changes one — the dialog, and an agent driving `team.assign` — goes
// through it. A single-assignment checker lived here once and was the weaker
// of the two: it knew about blank names and duplicate addresses but not about
// the lead a team needs, nor about a pane already belonging to another team,
// so the same change the dialog refused went through over MCP.

/** The panes making up the team called `name`, in deck order. Empty for a
 * name no team here holds. */
export function teamMembers(workspace: Workspace, name: string): Pane[] {
  const team = findTeamByName(workspace, name);
  return team ? membersOf(workspace, team.id) : [];
}

/**
 * Whether this pane is on the team called `name`.
 *
 * The name is resolved to the workspace's team and the pane compared by ID —
 * one reading, in one place. The person typing "API" means the team they
 * called "api", which the name lookup settles; a pane is never matched by
 * spelling. The moment membership means something else (a pane on two
 * teams, a folding rule) this is the one site that changes.
 */
export function paneIsOnTeam(
  workspace: Workspace,
  pane: Pane,
  name: string,
): boolean {
  const team = findTeamByName(workspace, name);
  return team !== undefined && pane.team?.teamId === team.id;
}

/**
 * Resolve who `ref` means, for a message sent by `from`.
 *
 * A teammate's ROLE wins over anything else. That ordering is the point of
 * having roles at all: an agent told "report to lead" must reach the lead
 * even in a workspace where some pane happens to be titled "lead", and a
 * role is the one name a teammate can be sure of — pane titles follow the
 * terminal and change under them.
 *
 * Everything else falls through to the ordinary pane reference (id, title,
 * user-given name), so a workspace with no teams keeps working exactly as
 * it did.
 */
export function resolveMailTarget(
  workspace: Workspace,
  agents: readonly { id: string; label: string }[],
  from: Pane,
  ref: string,
): Resolved<Pane> {
  const team = teamOfPane(workspace, from);
  if (team) {
    const needle = ref.trim().toLowerCase();
    const mate = membersOf(workspace, team.id).find(
      (pane) => pane.team?.role.toLowerCase() === needle,
    );
    if (mate) return { ok: true, value: mate };
  }
  const fallback = resolvePaneRef(workspace, agents, ref);
  if (fallback.ok || !team) return fallback;
  // Inside a team the refusal should say what the sender could have said,
  // because "no agent X" sends an agent looking for a window title it was
  // never given.
  const roles = membersOf(workspace, team.id)
    .filter((pane) => pane.id !== from.id)
    .map((pane) => pane.team?.role)
    .filter((role): role is string => Boolean(role));
  return {
    ok: false,
    message: roles.length
      ? `${fallback.message}; in team "${team.name}" you can write to: ${roles.join(", ")}`
      : fallback.message,
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
