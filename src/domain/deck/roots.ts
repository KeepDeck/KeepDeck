/**
 * Which DIRECTORIES the deck touches — the projections from panes to paths.
 *
 * One question, four answers to it: where a pane runs, how many run in one
 * place, which places a workspace occupies, and which places the app watches.
 * Everything KeepDeck plants in a working directory, and every git observation
 * it makes, keys off this — so it has a home of its own rather than sharing
 * one with workspace membership and pane state transitions, which change for
 * entirely different reasons.
 */
import type { Pane } from "./panes";
import type { Workspace } from "./workspaces";

/** The directory a pane would run in right now. Provisioning panes without a
 * resolved `cwd` deliberately have none yet: falling back to the workspace cwd
 * would describe the wrong process location. */
export function paneExecutionCwd(ws: Workspace, pane: Pane): string | null {
  if (pane.provisioning && !pane.cwd) return null;
  return pane.cwd ?? ws.cwd;
}

/** How many live panes run in `cwd`, across every workspace.
 *
 * The question a per-directory delivery has to ask: a config file is ONE file,
 * so a directory two panes run in cannot carry a per-pane secret. Counted off
 * the deck rather than remembered, because panes come and go between spawns. */
export function panesRunningIn(workspaces: Workspace[], cwd: string): number {
  return workspaces.reduce(
    (count, ws) =>
      count + ws.panes.filter((pane) => paneExecutionCwd(ws, pane) === cwd).length,
    0,
  );
}

/** The workspace's pane spawn cwds, deduped: worktree roots and the
 * workspace cwd alike — wherever a CLI actually starts. Skills staging arms
 * each of these with the codex-facing `.agents/skills` symlink. */
export function skillRootsOf(ws: Workspace): string[] {
  return [
    ...new Set(
      ws.panes.filter((p) => !p.provisioning).map((p) => p.cwd ?? ws.cwd),
    ),
  ];
}

/** The distinct effective directories whose git HEAD the app may observe for
 * pane-header branch badges and worktree cleanup decisions. */
export function gitWatchPaths(workspaces: Workspace[]): Set<string> {
  const paths = new Set<string>();
  for (const ws of workspaces) {
    for (const pane of ws.panes) {
      const path = paneExecutionCwd(ws, pane);
      if (path) paths.add(path);
    }
  }
  return paths;
}
