import type { TeamSnapshot, WorkspaceSnapshot } from "@keepdeck/plugin-api";
import {
  paneWorktree,
  paneBranch,
  teamsOf,
  type Pane,
  type Team,
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
    panes: ws.panes.map((pane) => toPaneSnapshot(ws, pane)),
    teams: teamsOf(ws).map(toTeamSnapshot),
  };
}

function toPaneSnapshot(ws: Workspace, pane: Pane) {
  // Sparse, as the snapshot contract promises: `cwd` is "absent while
  // provisioning", and `branch` names the pane's work whether it owns a
  // worktree for it or recorded it from the root.
  const worktree = paneWorktree(ws, pane);
  const branch = paneBranch(ws, pane);
  return {
    id: pane.id,
    // The same precedence the pane header renders: manual name, auto title,
    // then the bare id — a plugin should never see a nameless pane.
    name: pane.name ?? pane.autoTitle ?? pane.id,
    ...(worktree !== null && { cwd: worktree.cwd }),
    ...(branch !== undefined && { branch }),
    agentType: pane.agentType ?? "unknown",
    ...(pane.team !== undefined && { team: pane.team.teamId }),
  };
}

/** A team as facts: where it runs and on what. Sparse like a pane — no
 * directory while the create is in flight, and then the branch it is
 * heading for is the one it will have. */
function toTeamSnapshot(team: Team): TeamSnapshot {
  const location = team.location;
  const cwd = location?.kind === "attached" ? location.cwd : undefined;
  const branch =
    location?.kind === "attached"
      ? location.branch
      : location?.kind === "provisioning"
        ? location.intent.branch
        : undefined;
  return {
    id: team.id,
    name: team.name,
    ...(cwd !== undefined && { cwd }),
    ...(branch !== undefined && { branch }),
  };
}
