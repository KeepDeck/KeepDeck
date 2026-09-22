/**
 * The grammar of a mail address, in one place.
 *
 * A role names a teammate on the sender's OWN team — `impl-1`. A member of
 * another team is named through its team as well — `impl-1@team-3f9a1c20`
 * — where the team half is the team's ID. An address is SHOWN only with
 * the id: a name changes when the team is renamed, and a reply copied from
 * a stale name reached nobody — or, in another workspace, a team that
 * happened to share the name. A name is still READ as the team half, inside
 * the sender's own workspace, for whoever types one. The role half never
 * holds an `@`: the catalog admits only `[a-z][a-z0-9-]*` ids, numbered
 * with `-N`. So the split is at the FIRST `@`, and a team name typed there
 * may carry one of its own.
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

/** The address a member of `team` is reached by from outside it — by the
 * team's id, never its name (see the grammar above). */
export function formatAddress(role: string, team: { id: string }): string {
  return `${role}@${team.id}`;
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
