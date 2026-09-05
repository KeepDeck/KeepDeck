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
import { locationOf, type Pane } from "./panes";
import type { Workspace } from "./workspaces";

/** The directory a pane would run in right now. A provisioning pane
 * deliberately has none yet: falling back to the workspace cwd would describe
 * the wrong process location. A remote pane answers the workspace cwd — that
 * is where its local thin client runs. */
export function paneExecutionCwd(
  ws: Pick<Workspace, "cwd">,
  pane: Pane,
): string | null {
  const location = locationOf(pane);
  switch (location.kind) {
    case "provisioning":
      return null;
    case "attached":
      return location.cwd;
    case "main":
    case "remote":
      return ws.cwd;
  }
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
      ws.panes
        .map((p) => locationOf(p))
        .filter((location) => location.kind !== "provisioning")
        .map((location) => (location.kind === "attached" ? location.cwd : ws.cwd)),
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

/**
 * The workspace's DIRECTORIES — where a session counts as "ran here": the
 * workspace's own folder plus the folders its current panes run in
 * (worktree roots included). `worktreeBaseDir` is deliberately NOT a
 * source: it is only a suggestion of where panes' worktrees may land, and
 * a pane's worktree can live anywhere — deriving folders from the base
 * root would claim every sibling worktree ever created under it.
 *
 * The set is exactly what its two sources say, no prefix logic anywhere:
 * `/wt/kd-KeepDeck-1` and `/wt/kd-KeepDeck-12` share a base and a stem and
 * are still two different folders.
 */
export function workspaceDirectories(
  ws: Pick<Workspace, "cwd"> & { panes: Workspace["panes"] },
): ReadonlySet<string> {
  const dirs = new Set([ws.cwd]);
  for (const pane of ws.panes) {
    const path = paneExecutionCwd(ws, pane);
    if (path) dirs.add(path);
  }
  return dirs;
}

/**
 * Grow a directory set with the folders a workspace worked in BEFORE —
 * the journal's recorded cwds. Journal-AGNOSTIC on purpose: it takes bare
 * paths, so the set-building method stays substitutable (own-only, plus
 * current panes, plus history — three builders, one predicate), and no
 * journal type leaks into the directory rule. Blank paths never land in
 * the set: an empty cwd is a missing answer, not a folder.
 */
export function withHistoricalDirectories(
  dirs: ReadonlySet<string>,
  cwds: ReadonlyArray<string>,
): ReadonlySet<string> {
  const grown = new Set(dirs);
  for (const cwd of cwds) {
    if (cwd !== "") grown.add(cwd);
  }
  return grown;
}

/**
 * Whether `path` is one of `dirs` — membership by EXACT path. Not a
 * prefix, not a base root: a longer sibling never matches, and the empty
 * path (a session with no recorded directory) belongs nowhere.
 */
export function pathBelongsTo(dirs: ReadonlySet<string>, path: string): boolean {
  return path !== "" && dirs.has(path);
}

/**
 * THE workspace-scope policy, named once: which directories make a
 * session "ran here" — the user's chosen widest rule, the workspace's
 * own folder ∪ its panes' folders ∪ the folders its journal history
 * remembers. Own-plus-panes come from the deck's live state; the
 * remembered folders are passed as bare paths (journal-agnostic, so
 * this stays a pure function over data). This is the ONE address of the
 * rule — callers pass its output to the folder-scoped index asks.
 */
export function workspaceScopeDirectories(
  ws: Pick<Workspace, "cwd"> & { panes: Workspace["panes"] },
  historicalCwds: ReadonlyArray<string>,
): ReadonlySet<string> {
  return withHistoricalDirectories(workspaceDirectories(ws), historicalCwds);
}
