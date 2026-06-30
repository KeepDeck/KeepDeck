import type { AgentType } from "./agents";
import { addPane, appendPane, removePane, type Pane } from "./panes";

/** A workspace owns its own set of agent panes, all running the same agent type
 * in the same working directory. Switching the active workspace swaps which set
 * the grid shows; inactive workspaces keep their panes (and live sessions)
 * mounted. */
export interface Workspace {
  id: string;
  name: string;
  /** Working directory all this workspace's agents run in. */
  cwd: string;
  /** Coding-agent kind spawned in this workspace's panes. */
  agentType: AgentType;
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

/** Add an agent pane (numbered `seq`) to one workspace, respecting its cap. */
export function addAgent(
  workspaces: Workspace[],
  workspaceId: string,
  seq: number,
): Workspace[] {
  return mapWorkspace(workspaces, workspaceId, (panes) => addPane(panes, seq));
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

/** Which workspace to focus: keep `activeId` if it still exists, otherwise the
 * first remaining workspace (or `""` when none remain). */
export function resolveActiveId(workspaces: Workspace[], activeId: string): string {
  if (workspaces.some((ws) => ws.id === activeId)) return activeId;
  return workspaces[0]?.id ?? "";
}
