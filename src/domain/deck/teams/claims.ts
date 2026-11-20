/**
 * The page's rules for a team's directory as a path: which one a team holds,
 * and when two spellings name the same folder. Who holds a directory — and
 * so whether a place is free, or what a close leaves alone — is the
 * lifecycle machine's answer (`lifecycle_claims`, `lifecycle_location`),
 * never derived here.
 */
import type { Workspace } from "../workspaces";
import type { Team } from "./model";

/** A team already working in a folder, as the deck names it: its id and
 * name, and its workspace's name when that is not the asking one. */
export interface DirectoryHolder {
  teamId: string;
  teamName: string;
  /** Set only for a team in another workspace. */
  workspace?: string;
}

/** The team of `ws` working in folder `cwd` — the one a new member asking
 * for that folder joins. Only `ws`'s own: a workspace's root is its own. */
export function teamWorkingIn(ws: Pick<Workspace, "teams">, cwd: string): Team | undefined {
  return (ws.teams ?? []).find((team) => team.location?.kind === "attached" && sameDirectory(team.location.cwd, cwd));
}

/** The first of `teamIds` — the teams the machine says work in a folder —
 * that the deck still holds, named as a person reads it. Null for none.
 * `scope: "here"` asks about the workspace's own root, which every
 * workspace on a repository holds for itself: a team on the same folder in
 * another workspace does not hold it. */
export function directoryHolder(
  workspaces: readonly Workspace[],
  teamIds: readonly string[],
  here: string,
  scope: "anywhere" | "here",
): DirectoryHolder | null {
  const asked = scope === "here" ? workspaces.filter((ws) => ws.id === here) : workspaces;
  for (const teamId of teamIds) {
    for (const ws of asked) {
      const team = (ws.teams ?? []).find((candidate) => candidate.id === teamId);
      if (team) return { teamId, teamName: team.name, ...(ws.id !== here && { workspace: ws.name }) };
    }
  }
  return null;
}

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
