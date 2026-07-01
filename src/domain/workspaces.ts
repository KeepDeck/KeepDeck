import { appendPane, removePane, type Pane } from "./panes";

/** A workspace owns its own set of agent panes, all running the same agent type
 * in the same working directory. Switching the active workspace swaps which set
 * the grid shows; inactive workspaces keep their panes (and live sessions)
 * mounted. */
export interface Workspace {
  id: string;
  name: string;
  /** Working directory all this workspace's agents run in. */
  cwd: string;
  /** Base folder holding this workspace's per-agent git worktrees; `null` when
   * agents run directly in `cwd` (no isolation). */
  worktreeBaseDir: string | null;
  panes: Pane[];
}

/** Apply a pane transform to the workspace with `id`, leaving the rest as-is. */
function mapWorkspace(
  workspaces: Workspace[],
  id: string,
  transform: (panes: Pane[]) => Pane[],
): Workspace[] {
  return workspaces.map((ws) =>
    ws.id === id ? { ...ws, panes: transform(ws.panes) } : ws,
  );
}

/** Append an already-formed agent pane (e.g. with a provisioned worktree) to one
 * workspace, respecting its cap. */
export function addAgentPane(
  workspaces: Workspace[],
  workspaceId: string,
  pane: Pane,
): Workspace[] {
  return mapWorkspace(workspaces, workspaceId, (panes) => appendPane(panes, pane));
}

/** Remove an agent pane from one workspace. */
export function closeAgent(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
): Workspace[] {
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    removePane(panes, paneId),
  );
}

/** Remove a workspace. Its panes unmount, which tears down their PTY sessions. */
export function closeWorkspace(workspaces: Workspace[], id: string): Workspace[] {
  return workspaces.filter((ws) => ws.id !== id);
}

/** A git worktree + branch to tear down when an agent or workspace closes. */
export interface WorktreeTarget {
  /** The repository (the workspace cwd) the git ops run against. */
  repo: string;
  /** The worktree directory to remove. */
  path: string;
  /** The branch to delete once the worktree is gone. */
  branch: string;
}

/**
 * The worktrees owned by a workspace's panes — just the one pane when `paneId`
 * is given (agent close), else every pane (workspace close). Only panes that
 * actually run in a worktree (both a `cwd` and a `branch`) are returned; a
 * cwd-fallback pane, or a non-worktree workspace, owns nothing to delete, so an
 * empty result is the signal that there's nothing to offer deleting.
 */
export function worktreeTargets(ws: Workspace, paneId?: string): WorktreeTarget[] {
  const panes = paneId ? ws.panes.filter((p) => p.id === paneId) : ws.panes;
  return panes.flatMap((p) =>
    p.cwd && p.branch ? [{ repo: ws.cwd, path: p.cwd, branch: p.branch }] : [],
  );
}

/** Rename one workspace, leaving the rest untouched. */
export function renameWorkspace(
  workspaces: Workspace[],
  id: string,
  name: string,
): Workspace[] {
  return workspaces.map((ws) => (ws.id === id ? { ...ws, name } : ws));
}

/** Set a pane's manual display name; an empty name clears it, reverting to the
 * auto title / derived label ([F11]). */
export function renamePane(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  name: string,
): Workspace[] {
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) =>
      p.id === paneId ? { ...p, name: name.trim() || undefined } : p,
    ),
  );
}

/** Set a pane's auto title from the terminal (OSC title); empty clears it ([F11]). */
export function setPaneAutoTitle(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  title: string,
): Workspace[] {
  const next = title.trim() || undefined;
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) => (p.id === paneId ? { ...p, autoTitle: next } : p)),
  );
}

/** Move the workspace with `id` to `toIndex` (clamped to the list), preserving
 * the order of the rest. Returns the SAME array reference when nothing moves, so
 * a live drag that lands on the current slot doesn't trigger a re-render. */
export function moveWorkspace(
  workspaces: Workspace[],
  id: string,
  toIndex: number,
): Workspace[] {
  const from = workspaces.findIndex((ws) => ws.id === id);
  if (from < 0) return workspaces;
  const to = Math.max(0, Math.min(toIndex, workspaces.length - 1));
  if (from === to) return workspaces;
  const next = workspaces.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Which workspace to focus: keep `activeId` if it still exists, otherwise the
 * first remaining workspace (or `""` when none remain). */
export function resolveActiveId(workspaces: Workspace[], activeId: string): string {
  if (workspaces.some((ws) => ws.id === activeId)) return activeId;
  return workspaces[0]?.id ?? "";
}
