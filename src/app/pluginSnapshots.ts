import type { WorkspaceSnapshot } from "@keepdeck/plugin-api";
import type { Pane, Workspace } from "../domain/deck";

/**
 * Project a deck workspace into the serializable snapshot plugins see.
 * Deliberately lossy: runtime-only concerns (dormancy, provisioning, session
 * bindings, extras) are the host's business — a plugin gets identity and
 * location, the same data that would cross the external tier's RPC boundary.
 */
export function toWorkspaceSnapshot(ws: Workspace): WorkspaceSnapshot {
  return {
    id: ws.id,
    name: ws.name,
    cwd: ws.cwd,
    panes: ws.panes.map(toPaneSnapshot),
  };
}

function toPaneSnapshot(pane: Pane) {
  return {
    id: pane.id,
    // The same precedence the pane header renders: manual name, auto title,
    // then the bare id — a plugin should never see a nameless pane.
    name: pane.name ?? pane.autoTitle ?? pane.id,
    ...(pane.cwd !== undefined && { cwd: pane.cwd }),
    ...(pane.branch !== undefined && { branch: pane.branch }),
    agentType: pane.agentType ?? "unknown",
  };
}
