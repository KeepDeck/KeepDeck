import type { GitStatus, WorkspaceSnapshot } from "@keepdeck/plugin-api";
import { headline } from "./status";

/**
 * Which repositories the tab can show — the facts behind the root picker.
 *
 * One row per DIRECTORY, never per pane: two panes on one team run in one
 * worktree, and that worktree is one repository to look at. A row knows the
 * team whose directory it is (its name and branch), so the picker can name
 * what a person names — "the api team's tree" — instead of a folder's last
 * segment. The workspace folder is always the last row.
 *
 * Only directories a pane RUNS in are rows. A team with nobody on it keeps
 * a directory, but the host lets a plugin read only where a process is
 * (the fs and git scopes are built from the panes), so listing its folder
 * would offer a repository the status read then refuses. Whether an empty
 * team's tree should be readable is a host decision, not this plugin's.
 */
export interface RootFact {
  /** The directory — the value a status read is asked for. */
  cwd: string;
  /** The team whose directory it is; none for the workspace folder or a
   * directory no team claims. */
  team?: { id: string; name: string };
  branch?: string;
  /** How many panes run here. */
  agents: number;
  /** The workspace's own folder rather than a team's worktree. */
  workspace: boolean;
}

export function rootFacts(ws: WorkspaceSnapshot): RootFact[] {
  const byDir = new Map<string, RootFact>();
  for (const pane of ws.panes) {
    if (!pane.cwd || pane.cwd === ws.cwd) continue;
    const team = pane.team ? ws.teams.find((t) => t.id === pane.team) : undefined;
    const known = byDir.get(pane.cwd);
    if (known) {
      known.agents += 1;
      continue;
    }
    byDir.set(pane.cwd, {
      cwd: pane.cwd,
      ...(team && { team: { id: team.id, name: team.name } }),
      ...((team?.branch ?? pane.branch) !== undefined && {
        branch: team?.branch ?? pane.branch,
      }),
      agents: 1,
      workspace: false,
    });
  }
  const onRoot = ws.panes.filter((pane) => pane.cwd === undefined || pane.cwd === ws.cwd).length;
  return [
    ...byDir.values(),
    { cwd: ws.cwd, agents: onRoot, workspace: true },
  ];
}

/** The facts with one root's HEAD named by its own status. The host names
 * a tree by its branch and says nothing for a detached one, so a checked
 * out commit had no line at all; the status — which knows the commit —
 * fills that gap for the root it was read for (`abc1234 (detached)`). A
 * branch the host named stays its word; the workspace folder carries no
 * branch line by design. */
export function withHead(
  facts: RootFact[],
  cwd: string,
  status: GitStatus | null,
): RootFact[] {
  if (!status) return facts;
  return facts.map((fact) =>
    fact.cwd === cwd && !fact.workspace && fact.branch === undefined
      ? { ...fact, branch: headline(status) }
      : fact,
  );
}
