/**
 * Admitting a member to a team under a role — ONE rule, answered once.
 *
 * A role is an ADDRESS: known to the catalog, so its holder has a charter to
 * be briefed with, and unique on its team, so a message to it reaches one
 * pane. Every door onto a team asks this — the dialog, `team.add`,
 * `agent.spawn`, a relocation — and the deck's reducer applies the answer
 * without judging it again.
 *
 * The policy, said once. A role that was ASKED FOR is honoured or refused,
 * never quietly replaced: a caller that asked for `impl-1` and was handed
 * `impl-2` under "created" was told a lie, and the person who picked the
 * role in a dialog was overruled in silence. A role nobody asked for is
 * suggested from the roster.
 *
 * It used to be decided four times, with three answers — the command threw,
 * the plan refused, the landing substituted, the reducer wrote nothing — and
 * which one a caller met depended on the door it came through.
 */
import { membersOf, roleTaken, type Workspace } from "../deck";
import { parseRoleAddress, suggestRoleAddress } from "./roles";

/** Why an asked-for role cannot be taken. */
export type RoleRefusal = "taken" | "unknown";

export type RoleAdmission =
  | { ok: true; role: string }
  | { ok: false; why: RoleRefusal; role: string };

/**
 * The role `asked` for on team `teamId` when it may be taken, the refusal
 * when it may not, or a suggested one when nothing was asked. `except` is
 * a pane whose own current role does not count as held — the pane being
 * moved onto the team.
 */
export function admitRole(
  workspace: Workspace,
  teamId: string,
  asked?: string,
  except?: string,
): RoleAdmission {
  const wanted = asked?.trim();
  if (!wanted) {
    const held = membersOf(workspace, teamId)
      .filter((member) => member.id !== except)
      .flatMap((member) => (member.team ? [member.team.role] : []));
    return { ok: true, role: suggestRoleAddress(held) };
  }
  if (!parseRoleAddress(wanted)) return { ok: false, why: "unknown", role: wanted };
  if (roleTaken(workspace, teamId, wanted, except)) {
    return { ok: false, why: "taken", role: wanted };
  }
  return { ok: true, role: wanted };
}

/** The refusal in words — the same words whichever door asked. */
export function roleRefusalMessage(why: RoleRefusal, role: string): string {
  switch (why) {
    case "taken":
      return `role "${role}" is taken on that team — a role is an address, so it has to be unique`;
    case "unknown":
      return `"${role}" is not a role this deck knows`;
  }
}
