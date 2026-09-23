/**
 * The role picker's data, built once from what the target team holds.
 *
 * Which roles a team is open to, and the address each would take, are the
 * domain's answer ([`rolesOpenTo`]) — so a team with nobody on it offers a
 * lead or a peer, a led team its working roles, a flat team another peer,
 * and the picker never offers a role the landing would refuse. Nothing is
 * picked in advance: a role is chosen, never defaulted into.
 */
import { rolesOpenTo } from "../domain/mail";

export interface RoleOption {
  value: string;
  label: string;
}

/** The picker before anybody has picked. */
export const NO_ROLE = "";

export const ROLE_WORDS = {
  label: "Role",
  prompt: "Pick a role",
  /** Ahead of the address a pick takes. */
  writeTo: "Teammates write to",
  unpicked: "Pick what it is on this team for — nothing is chosen for it",
  /** A roster no role can join — one the deck cannot read. */
  closed: "No role can join this team as its roster stands",
} as const;

export interface RoleChoice {
  /** The roles on offer, in catalog order — the prompt ahead of them until
   * one is picked. */
  optionsFor(picked: string): RoleOption[];
  /** The address a pick takes on the team, or null for no pick. */
  addressFor(roleId: string): string | null;
  /** `picked` while the team is still open to it, else no pick — a role
   * the catalog lost (or the roster closed) is not a pick any more. */
  pickOf(picked: string): string;
  /** The line under the field while nothing is picked. */
  unpickedHint: string;
}

export function roleChoiceView(heldRoles: readonly string[]): RoleChoice {
  const open = rolesOpenTo(heldRoles);
  const options = open.map(({ role }) => ({ value: role.id, label: role.label }));
  return {
    optionsFor: (picked) =>
      picked === NO_ROLE ? [{ value: NO_ROLE, label: ROLE_WORDS.prompt }, ...options] : options,
    addressFor: (roleId) => open.find(({ role }) => role.id === roleId)?.address ?? null,
    pickOf: (picked) => (open.some(({ role }) => role.id === picked) ? picked : NO_ROLE),
    unpickedHint: open.length > 0 ? ROLE_WORDS.unpicked : ROLE_WORDS.closed,
  };
}
