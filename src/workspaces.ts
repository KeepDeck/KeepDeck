import { addPane, removePane, type Pane } from "./panes";

/** A workspace owns its own set of agent panes. Switching the active workspace
 * swaps which set the grid shows; inactive workspaces keep their panes (and
 * their live sessions) mounted. */
export interface Workspace {
  id: string;
  name: string;
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

/** Append a new, empty workspace numbered `seq`. */
export function addWorkspace(workspaces: Workspace[], seq: number): Workspace[] {
  return [
    ...workspaces,
    { id: `ws-${seq}`, name: `workspace-${seq}`, panes: [] },
  ];
}
