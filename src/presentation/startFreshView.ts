/**
 * "Start fresh" on a pane whose directory is gone moves it onto the team
 * holding the workspace root, and the pane keeps its role ([`carryRole`]).
 * When that role cannot come along — a singleton the root's team already
 * holds, a shape that team cannot take, a pane that never had one — the
 * card asks for the role it takes there instead of the move failing.
 */
import { claimPath, type Pane, type Workspace } from "../domain/deck";
import { carryRoleInto, rolesOnTeam } from "../domain/mail";
import { roleChoiceView, type RoleChoice } from "./roleChoiceView";

export const START_FRESH_WORDS = {
  action: "Start fresh in the workspace folder",
  /** Over the role picker, when the pane's role cannot come along. */
  pickRole: "Its role cannot come along to the workspace folder's team — pick the one it takes there",
} as const;

/** The roles to pick from before the move, or null when the pane's own
 * role carries onto the root's team. */
export function startFreshRoles(workspaces: readonly Workspace[], ws: Workspace, pane: Pane): RoleChoice | null {
  const claim = claimPath(workspaces, ws, ws.cwd);
  // A root nobody here holds gets a team minted for the pane: nobody on it.
  const held = claim.kind === "held" && claim.ws.id === ws.id ? rolesOnTeam(ws, claim.team.id, pane.id) : [];
  return carryRoleInto(held, pane.team?.role).ok ? null : roleChoiceView(held);
}

/** Whether Start fresh may be pressed, and the role it moves the pane
 * under: ready at once when the pane's role carries, else once a role is
 * picked. */
export function startFreshPick(
  roles: RoleChoice | null,
  picked: string,
): { ready: boolean; role: string | undefined } {
  if (!roles) return { ready: true, role: undefined };
  const address = roles.addressFor(picked);
  return { ready: address !== null, role: address ?? undefined };
}
