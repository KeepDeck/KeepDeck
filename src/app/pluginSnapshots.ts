import type { WorkspaceSnapshot } from "@keepdeck/plugin-api";
import {
  attachedWorktree,
  paneBranch,
  type Pane,
  type Workspace,
} from "../domain/deck";

/**
 * Project a deck workspace into the serializable snapshot plugins see.
 * Deliberately lossy: runtime-only concerns (dormancy, provisioning, session
 * bindings, extras) are the host's business — a plugin gets identity and
 * location, the same data that would cross the external tier's RPC boundary.
 */
export function toWorkspaceSnapshot(ws: Workspace): WorkspaceSnapshot {
  return {
    id: ws.id,
    instance: ws.instance,
    name: ws.name,
    cwd: ws.cwd,
    panes: ws.panes.map(toPaneSnapshot),
  };
}

function toPaneSnapshot(pane: Pane) {
  // Sparse, as the snapshot contract promises: `cwd` is "absent while
  // provisioning", and `branch` names the pane's work whether it owns a
  // worktree for it or recorded it from the root.
  const worktree = attachedWorktree(pane);
  const branch = paneBranch(pane);
  return {
    id: pane.id,
    // The same precedence the pane header renders: manual name, auto title,
    // then the bare id — a plugin should never see a nameless pane.
    name: pane.name ?? pane.autoTitle ?? pane.id,
    ...(worktree !== null && { cwd: worktree.cwd }),
    ...(branch !== undefined && { branch }),
    agentType: pane.agentType ?? "unknown",
  };
}
