/**
 * The grammar of a mail address, in one place.
 *
 * A role names a teammate on the sender's OWN team — `impl-1`. A member of
 * another team in the same workspace is named through its team as well —
 * `impl-1@web` — where the team half is the name people address the team
 * by, or its id. The role half never holds an `@`: the catalog admits only
 * `[a-z][a-z0-9-]*` ids, numbered with `-N`. So the split is at the FIRST
 * `@`, and a team name may carry one of its own.
 *
 * Formatting and parsing sit together so the address a receiver is SHOWN
 * is one the resolver will READ. Two sites spelling the grammar is how one
 * comes to print what the other refuses — which is what the bare role did
 * across teams: a sender on another team was shown as `lead`, and the reply
 * to `lead` reached the receiver's own lead instead.
 */
export interface TeamAddress {
  role: string;
  team: string;
}

/** The address a member of `team` is reached by from outside it. */
export function formatAddress(role: string, team: string): string {
  return `${role}@${team}`;
}

/**
 * The role and team an address names, or null for a bare one — a role on
 * the sender's own team, or a pane by title or id. Blank halves are not an
 * address: `@web` names no role and `lead@` names no team.
 */
export function parseAddress(ref: string): TeamAddress | null {
  const at = ref.indexOf("@");
  if (at < 0) return null;
  const role = ref.slice(0, at).trim();
  const team = ref.slice(at + 1).trim();
  return role && team ? { role, team } : null;
}
