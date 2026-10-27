/**
 * Building panes: the agent dialog's request, as the landing takes it.
 *
 * A factory decides a pane's STARTING state, which is why they sit apart from
 * the questions asked about a pane later.
 *
 * There is one factory because panes arrive one at a time. The batch builders
 * that stood beside it belonged to a workspace created with N agents at once;
 * a workspace is born empty now, and every pane in it comes from a request.
 */
import type { AgentDialogResult, AgentType } from "../../agents";
import type { TeamLocation } from "../teams/model";
import type { Pane } from "./model";

/** What one agent-dialog request asks for: the pane, and the DIRECTORY it
 * wants — which the landing turns into the team the pane joins (the one
 * already holding that directory) or mints for it. The pane itself never
 * carries the directory: it is the team's. */
export interface PaneRequest {
  pane: Pane;
  placement: TeamLocation;
}

/**
 * The pane one agent-dialog request describes — all four shapes the dialog
 * offers, in one place: a remote pane carrying its endpoint, a pane running
 * in the workspace root, one attached to an existing directory, and one whose
 * worktree does not exist yet (its team lands as a provisioning card and the
 * create runs behind it). They were four near-identical branches in the
 * dialog, which is how the sparse-field convention came to be applied three
 * different ways across them.
 *
 * FRESH conversations only. A request that names a session is a resume or a
 * fork; those build their pane around the recorded session instead, and the
 * caller routes them there before reaching this.
 */
export function paneFromAgentRequest(
  id: string,
  /** The agent the pane runs — the request's, once the dialog has one. Apart
   * from the request because a request for a new team may carry none. */
  agentType: AgentType,
  request: AgentDialogResult,
  ws: { cwd: string },
  /** The pane's position for the auto branch name — captured when the dialog
   * opened, not recomputed here: the workspace may have gained panes since. */
  index: number,
): PaneRequest {
  const name = request.name.trim();
  // Sparse like persistence: only what is set lands on the pane.
  const pane: Pane = {
    id,
    ...(name && { name }),
    agentType,
    ...(request.yolo && { yolo: true }),
  };
  const placement = placementFromAgentRequest(request, ws, index);
  // Remote: a bare pane carrying the endpoint. The agent's cwd lives on the
  // box the server runs on, so the local directory is moot — the pane's
  // terminal runs the local thin-client attached to the endpoint, in the
  // root's team.
  return request.remoteEndpoint
    ? { pane: { ...pane, location: { kind: "remote", endpoint: request.remoteEndpoint } }, placement }
    : { pane, placement };
}

/**
 * The DIRECTORY one agent-dialog request asks for — which the landing turns
 * into the team that holds it. A new team needs only this: it is a name and
 * a directory, with no agent yet.
 */
export function placementFromAgentRequest(
  request: AgentDialogResult,
  ws: { cwd: string },
  index: number,
): TeamLocation {
  const { location } = request;
  // The root is a directory like any other: the team on it holds it. A
  // remote agent's cwd is on its server's box, so locally it joins the root.
  const root: TeamLocation = { kind: "attached", cwd: ws.cwd };
  if (request.remoteEndpoint || location.kind === "main") return root;
  // Existing worktree: attach in place, no git mutation ([F12]-lite).
  if (location.kind === "existing") {
    return {
      kind: "attached",
      cwd: location.path,
      ...(location.branch && { branch: location.branch }),
    };
  }
  // New worktree AT the chosen path, created verbatim with no suffix.
  return {
    kind: "provisioning",
    intent: {
      repo: ws.cwd,
      path: location.path,
      ...(location.branch && { branch: location.branch }),
      ...(location.baseBranch && { base: location.baseBranch }),
      index,
    },
  };
}
