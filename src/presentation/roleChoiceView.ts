/**
 * The role picker's data, built once from what the target team holds.
 *
 * The view used to reach into the catalog itself — which role a team opens
 * on, which address a pick would mint, whether a singleton is already
 * taken — and so a second surface with a role picker would have been a
 * second place deciding those. They are the catalog's rules
 * (`defaultRoleFor`, `mintRoleAddress`); this only asks them for one
 * roster and hands the answers to a view as data.
 */
import { defaultRoleFor, mintRoleAddress, roleById, teamRoles } from "../domain/mail";

export interface RoleOption {
  value: string;
  label: string;
}

export interface RoleChoice {
  /** Every role the catalog offers, in catalog order. */
  options: RoleOption[];
  /** The role the picker opens on: the lead where the team has none, else
   * the next implementer, or a peer among peers. */
  defaultId: string;
  /** The address a pick would mint against the roster, or null when the
   * team already holds that singleton — the form says so in words. */
  addressFor(roleId: string): string | null;
  /** The role's label, for the refusal line; the id when the catalog has
   * since lost the role. */
  labelOf(roleId: string): string;
}

export function roleChoiceView(heldRoles: readonly string[]): RoleChoice {
  return {
    options: teamRoles().map((role) => ({ value: role.id, label: role.label })),
    defaultId: defaultRoleFor(heldRoles).id,
    addressFor(roleId) {
      const role = roleById(roleId);
      return role ? mintRoleAddress(role, heldRoles) : null;
    },
    labelOf(roleId) {
      return roleById(roleId)?.label ?? roleId;
    },
  };
}
