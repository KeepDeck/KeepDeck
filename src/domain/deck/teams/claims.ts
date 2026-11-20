/**
 * The page's rules for a team's directory as a path: which one a team holds,
 * and when two spellings name the same folder. Who holds a directory — and
 * so whether a place is free, or what a close leaves alone — is the
 * lifecycle machine's answer (`lifecycle_claims`, `lifecycle_location`),
 * never derived here.
 */
import type { Team } from "./model";

/** The path a team holds for occupancy: the directory it runs in, or the one
 * its create is heading for. A team with no directory yet holds none. */
export function teamHeldPath(team: Pick<Team, "location">): string | undefined {
  const location = team.location;
  if (!location) return undefined;
  return location.kind === "attached" ? location.cwd : location.intent.path;
}

/** Path spelling differences that don't change the directory: surrounding
 * whitespace and trailing slashes. NOT a canonicalizer (no fs access). The
 * ONE rule every "is this the same directory" question asks — occupancy,
 * landing, and the root guard on a deletion target. */
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  const stripped = trimmed.replace(/\/+$/, "");
  return stripped === "" ? trimmed : stripped;
}

/** Whether two paths name the same directory — the deck's key for a
 * directory, not the raw strings ("/repo/" and "/repo" are one folder).
 * The ONE comparison for callers holding two paths; a caller testing many
 * paths against one keeps the normalized key itself. */
export function sameDirectory(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}
