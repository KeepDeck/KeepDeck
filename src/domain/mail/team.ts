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

/** The conventional role of whoever runs a team. Nothing enforces that one
 * exists — a team of peers is legitimate — but when it does, this is the
 * name to hold, so every agent can guess where to send a question. */
export const LEAD_ROLE = "lead";

export interface TeamAssignment {
  name: string;
  role: string;
}

/** Why an assignment was refused. */
export type TeamRefusal =
  /** Another pane in this workspace already answers to that role in that
   * team. Roles are addresses, and an ambiguous address is worse than none. */
  | "role-taken"
  /** A name has to be usable in a message. */
  | "blank";

/**
 * Whether `pane` may take `assignment` in `workspace`.
 *
 * Checked against the workspace rather than the team, because that is where
 * the panes are and where a duplicate could arise; a team is only the set of
 * panes claiming its name.
 */
export function checkTeamAssignment(
  workspace: Workspace,
  paneId: string,
  assignment: TeamAssignment,
): Resolved<TeamAssignment> {
  const name = assignment.name.trim();
  const role = assignment.role.trim();
  if (!name || !role) {
    return { ok: false, message: "a team and a role both need a name" };
  }
  const clash = workspace.panes.find(
    (pane) =>
      pane.id !== paneId &&
      pane.team?.name.toLowerCase() === name.toLowerCase() &&
      pane.team.role.toLowerCase() === role.toLowerCase(),
  );
  if (clash) {
    return {
      ok: false,
      message: `role "${role}" is already taken in team "${name}"`,
    };
  }
  return { ok: true, value: { name, role } };
}

/**
 * One field, both facts: `role@team`.
 *
 * Teams are two names and a header has room for one input, so they share it
 * the way an address does — and `name@team` is the shape Claude Code's own
 * teams use, which is what an agent reading about this elsewhere will
 * expect. Blank means "off the team", the same as clearing a rename means
 * "back to the automatic title".
 *
 * Returns null for blank (a removal) and for anything that is not exactly
 * two non-empty halves. Deliberately strict: `impl-1` alone would have to
 * guess a team, and guessing which team a pane joins is how a role ends up
 * answering in the wrong conversation.
 */
export function parseTeamSpec(text: string): TeamAssignment | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const at = trimmed.indexOf("@");
  if (at <= 0) return null;
  const role = trimmed.slice(0, at).trim();
  const name = trimmed.slice(at + 1).trim();
  if (!role || !name || name.includes("@")) return null;
  return { name, role };
}

/** The inverse, for filling the field with what is already there. */
export function formatTeamSpec(team: TeamAssignment | null | undefined): string {
  return team ? `${team.role}@${team.name}` : "";
}

/**
 * What a typed `role@team` means for this pane: the assignment to store,
 * null to take it off its team, or a refusal to show the person.
 *
 * The whole decision in one pure step, so the surface that collected the
 * text only has to dispatch or complain. A refusal reaches a HUMAN here,
 * unlike the command path's, which reaches an agent — but the wording is
 * the same because the mistake is: the role is taken, or the field was not
 * a `role@team`.
 */
export function decideTeamSpec(
  workspace: Workspace,
  paneId: string,
  spec: string,
): Resolved<TeamAssignment | null> {
  if (!spec.trim()) return { ok: true, value: null };
  const parsed = parseTeamSpec(spec);
  if (!parsed) {
    return {
      ok: false,
      message: `"${spec.trim()}" is not a role and a team — write it as role@team, for example lead@api`,
    };
  }
  const checked = checkTeamAssignment(workspace, paneId, parsed);
  return checked.ok ? { ok: true, value: checked.value } : checked;
}

/** The panes making up a team, in deck order. */
export function teamMembers(workspace: Workspace, name: string): Pane[] {
  const needle = name.trim().toLowerCase();
  return workspace.panes.filter(
    (pane) => pane.team?.name.toLowerCase() === needle,
  );
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
