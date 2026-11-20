/**
 * What stands in the way of a team about to be born, asked before the
 * lifecycle machine is: a name a team here already answers to, or a folder
 * another team already works in. The second is no refusal of the machine's —
 * two teams may share a folder — but each door asks its asker first: the
 * "+ Team" dialog asks the person, and `team.create` tells the agent the flag
 * that means it. One owner, so the two doors cannot ask it differently.
 */
import { directoryHolder, normalizePath, teamNameTaken, type DirectoryHolder, type Workspace } from "../domain/deck";
import type { Site } from "../domain/lifecycle";

export type TeamBirthBlock =
  | { kind: "taken"; name: string }
  /** `path` is the folder as one spelling names it. */
  | { kind: "shared"; holder: DirectoryHolder; path: string };

export interface TeamBirthAsk {
  ws: Workspace;
  workspaces: readonly Workspace[];
  name: string;
  site: Site;
  /** The teams the machine says work in a folder. */
  teamsIn(path: string): Promise<string[]>;
}

export async function teamBirthBlock({ ws, workspaces, name, site, teamsIn }: TeamBirthAsk): Promise<TeamBirthBlock | null> {
  const asked = name.trim();
  if (asked && teamNameTaken(ws, asked)) return { kind: "taken", name: asked };
  // A new worktree's place is the machine's to refuse when held.
  if (site.kind === "new") return null;
  const path = normalizePath(site.kind === "root" ? ws.cwd : site.cwd);
  // The root is every workspace's own: only a team here holds it.
  const holder = directoryHolder(workspaces, await teamsIn(path), ws.id, site.kind === "root" ? "here" : "anywhere");
  return holder ? { kind: "shared", holder, path } : null;
}
