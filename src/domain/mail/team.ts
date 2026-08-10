/**
 * Teams, as far as mail is concerned: who may be named, and by what name.
 *
 * A team is a grouping INSIDE a workspace, never across one — the workspace
 * stays the hard boundary, and a team only narrows addressing within it. It
 * exists because "ask impl-1" is what an agent can usefully be told, while
 * "ask the pane titled Claude 3" is a fact about a window.
 */
import { resolvePaneRef, type Resolved } from "../commands";
import type { Pane, Workspace } from "../deck";

export interface TeamAssignment {
  name: string;
  role: string;
}

// Whether a pane MAY take a role is not answered here, and deliberately not
// answered twice anywhere: `planTeam` settles a whole roster, and every path
// that changes one — the dialog, and an agent driving `team.assign` — goes
// through it. A single-assignment checker lived here once and was the weaker
// of the two: it knew about blank names and duplicate addresses but not about
// the lead a team needs, nor about a pane already belonging to another team,
// so the same change the dialog refused went through over MCP.

/** The panes making up a team, in deck order. */
export function teamMembers(workspace: Workspace, name: string): Pane[] {
  return workspace.panes.filter((pane) => paneIsOnTeam(pane, name));
}

/**
 * Whether this pane holds that team's name.
 *
 * One comparison, in one place. Membership is "the pane claims the name",
 * matched case- and space-insensitively for the same reason roles are: the
 * person typing "API" means the team they called "api". Three sites spelled
 * that out inline with three slightly different normalisations — they cannot
 * disagree while every stored name has been trimmed on the way in, but the
 * moment membership stops being a name comparison (an id, a pane on two
 * teams, a folding rule) the ones that were missed keep answering the old
 * question.
 */
export function paneIsOnTeam(pane: Pane, name: string): boolean {
  return pane.team?.name.trim().toLowerCase() === name.trim().toLowerCase();
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
  const team = from.team;
  if (team) {
    const needle = ref.trim().toLowerCase();
    const mate = teamMembers(workspace, team.name).find(
      (pane) => pane.team?.role.toLowerCase() === needle,
    );
    if (mate) return { ok: true, value: mate };
  }
  const fallback = resolvePaneRef(workspace, agents, ref);
  if (fallback.ok || !team) return fallback;
  // Inside a team the refusal should say what the sender could have said,
  // because "no agent X" sends an agent looking for a window title it was
  // never given.
  const roles = teamMembers(workspace, team.name)
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

/** How a pane's team reads in the roster. Null rather than absent, so the
 * shape does not change with membership. */
export function teamOf(pane: Pane): { name: string; role: string } | null {
  return pane.team ? { name: pane.team.name, role: pane.team.role } : null;
}
