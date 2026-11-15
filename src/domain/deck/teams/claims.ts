/**
 * Who holds which directory — the ONE derivation every such question reads.
 *
 * A team holds a directory: the one it runs in, or the one its create is
 * heading for ([`teamHeldPath`]). Every "is this directory taken", "who would
 * a pane join here", "what does a close leave alone" is a reading of the same
 * map ([`claimsOf`]) — the questions used to walk teams × held paths × the
 * path rule each on their own, and the rule they shared ("still lived in")
 * had to be written twice. The questions differ only in their exceptions,
 * and each states its own here, beside the others.
 */
import type { Workspace } from "../workspaces";
import { teamsOf } from "./collection";
import type { Team, TeamLocation } from "./model";
import { createIsOut } from "./placement";

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

/** One team's hold on a directory. */
export interface DirectoryHolder {
  ws: Workspace;
  team: Team;
}

/** Every directory a team holds, keyed by [`normalizePath`], its holders in
 * workspace order, then team order. */
export function claimsOf(workspaces: readonly Workspace[]): ReadonlyMap<string, readonly DirectoryHolder[]> {
  const claims = new Map<string, DirectoryHolder[]>();
  for (const ws of workspaces) {
    for (const team of teamsOf(ws)) {
      const held = teamHeldPath(team);
      if (held === undefined) continue;
      const key = normalizePath(held);
      const holders = claims.get(key);
      if (holders) holders.push({ ws, team });
      else claims.set(key, [{ ws, team }]);
    }
  }
  return claims;
}

/** The team already holding `path`, across every workspace — one directory
 * is one team's, by construction. Null when it is free. */
export function teamOccupyingPath(
  workspaces: readonly Workspace[],
  path: string,
): DirectoryHolder | null {
  const wanted = normalizePath(path);
  if (!wanted) return null;
  return claimsOf(workspaces).get(wanted)?.[0] ?? null;
}

/**
 * Who is in a directory — the FACT, not the verdict.
 *
 * The verdict differs by door, and belongs to the door: a team asking to be
 * BORN here may share the directory when the person says so ([`birthRefusal`]),
 * while a pane asking to LAND here simply joins the team that is in it. One
 * fact, two policies — merging them cost a release the ability to put a pane
 * on a team whose worktree was still being created.
 *
 * `team`/`ws` name the FIRST holder, this workspace's before any other — the
 * one a pane would join. `creating` is true when ANY holder at that path has
 * a create still out, because that fact is about the directory rather than
 * about whichever team happens to sit first in the list.
 *
 * The workspace ROOT is the one directory every workspace opened on the same
 * repository holds for itself, so a team on it in ANOTHER workspace is not a
 * claim here. A team on it in this one is, like any other directory.
 */
export type DirectoryClaim =
  | { kind: "free" }
  | { kind: "held"; ws: Workspace; team: Team; creating: boolean };

export function claimDirectory(
  workspaces: readonly Workspace[],
  /** The workspace asking — its own teams answer first, and its root is its
   * own however many other workspaces hold the same repository. */
  ws: Workspace,
  placement: TeamLocation,
): DirectoryClaim {
  return claimPath(workspaces, ws, teamHeldPath({ location: placement }) ?? "");
}

/** The same fact for a bare PATH — what a surface holding a directory and no
 * placement yet asks. The placement never changed the answer: [`claimDirectory`]
 * only ever read the path out of it, and inventing a placement to ask this
 * question is how a form came to ask about one thing and submit another. */
export function claimPath(
  workspaces: readonly Workspace[],
  ws: Workspace,
  path: string,
): DirectoryClaim {
  const wanted = normalizePath(path);
  if (!wanted) return { kind: "free" };
  // The asking workspace first — as given — then the others; another
  // workspace's team on THIS workspace's root is not a claim here.
  const root = normalizePath(ws.cwd);
  const holders = (claimsOf([ws, ...workspaces.filter((other) => other.id !== ws.id)]).get(wanted) ?? []).filter(
    (holder) => holder.ws.id === ws.id || wanted !== root,
  );
  const first = holders[0];
  if (!first) return { kind: "free" };
  return {
    kind: "held",
    ...first,
    creating: holders.some((held) => createIsOut(held.team.location)),
  };
}

/**
 * The directories teams are STILL working in once `ending` — teams of the
 * workspace `wsId` — are gone. What a close must leave alone: teams share a
 * directory, so a close is not always the last one out, and a worktree
 * somebody still works in outlives it. Read across every workspace, since
 * sharing crosses them too.
 */
export function directoriesStillHeld(
  workspaces: readonly Workspace[],
  wsId: string,
  ending: readonly string[],
): Set<string> {
  const leaving = new Set(ending);
  const kept = new Set<string>();
  for (const [directory, holders] of claimsOf(workspaces)) {
    // Only that workspace's teams are ending; the same id elsewhere is a
    // different team, and it keeps its directory.
    if (holders.some((holder) => holder.ws.id !== wsId || !leaving.has(holder.team.id))) kept.add(directory);
  }
  return kept;
}
