/**
 * The team model: a piece of work in progress, named once, and — from
 * stage C on — the ONE directory every agent on it runs in.
 *
 * A team used to be nothing but a name written on each of its panes: the
 * workspace held panes, and "the team" was whichever panes happened to spell
 * the same name. That made the name the key to membership, so renaming a
 * team meant rewriting every member, and nothing could own anything on the
 * team's behalf — a directory, a create in flight, a roster with nobody on
 * it yet. A team is an object now. Panes hold its ID and their role; the
 * name lives here and is an ADDRESS people type, not a join key.
 *
 * Kept beside [`../panes/model`], not inside it, for the same reason the
 * pane model sits apart from its barrel: `Team` is a value the workspace
 * carries, and a workspace importing a barrel that re-exports the workspace
 * is a cycle waiting for an import order to decide whether the app boots.
 */
import type { PaneLocation } from "../panes/model";

/**
 * Where a team runs — the two placements that name a directory: one the
 * team is attached to (a worktree the deck created, an existing folder, or
 * the workspace root itself — any directory, the team does not care which),
 * or one still being created. A team is never `main` (the root is simply a
 * directory it can be attached to) and never remote (that is still the pane's
 * own placement, until remote teams are a decision of their own).
 */
export type TeamLocation = Extract<
  PaneLocation,
  { kind: "attached" | "provisioning" }
>;

export interface Team {
  /** `team-N` — the join key every member holds. Minted by [`teamId`]. */
  id: string;
  /** The name people address the team by. Compared through [`teamNameKey`];
   * stored as it was written. Always present: a team the person did not
   * name gets [`autoTeamName`], the way a pane gets "Agent N". */
  name: string;
  /**
   * The directory the team's agents run in.
   *
   * Optional THROUGH the transition only. A team that exists as a roster
   * alone — today's named team, whose members still carry directories of
   * their own — has none; stage C2's migration gives every team one and
   * stage C3 removes the pane's own placement, after which a team without a
   * directory is not a team and this field stops being optional.
   */
  location?: TeamLocation;
  /** Persisted keys this build doesn't know (written by a newer revision) —
   * carried verbatim so a save round-trip never strips them, as on a pane. */
  extras?: Record<string, unknown>;
}

/** The id for the team numbered `seq` — the single mint point, like
 * [`paneId`]: every site that names a team must agree on the spelling. */
export function teamId(seq: number): string {
  return `team-${seq}`;
}

/** The name a team is born with when the person leaves the field blank —
 * "Team N" for `team-N`, by the "Agent N" precedent, so a team of one that
 * nobody bothered to name still has an address. */
export function autoTeamName(seq: number): string {
  return `Team ${seq}`;
}

/**
 * The key two team names are compared by: trimmed, lower-cased.
 *
 * A name is a badge, stored as the person wrote it; the KEY is how every
 * question about it — "is this name taken", "which team did they mean" — is
 * answered, and it is answered here once. Comparison and storage are
 * different questions: the sites that spelled the comparison inline had
 * already drifted (one trimmed, one did not) by the time this was named, and
 * a hand-edited document with " api " beside "api" read as two teams to one
 * of them and one team to the other.
 */
export function teamNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * A membership spoken by NAME: what the team dialog, the `team.assign`
 * command and the v10 document say — "this pane is `impl-1` on `api`". The
 * deck resolves the name to a team id at its boundary, so nothing past that
 * boundary ever compares names to find a team.
 */
export interface TeamAssignment {
  name: string;
  role: string;
}
