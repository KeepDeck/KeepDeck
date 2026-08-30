/**
 * Building panes: the "+ Agent" dialog, and the provisioning cards a worktree
 * create stands behind.
 *
 * A factory decides a pane's STARTING state, which is why they sit apart from
 * the questions asked about a pane later.
 *
 * There is one factory because panes arrive one at a time. The batch builders
 * that stood beside it belonged to a workspace created with N agents at once;
 * a workspace is born empty now, and every pane in it comes from a request.
 */
import type { AgentDialogResult } from "../../agents";
import type { Pane } from "./model";

/**
 * The pane one "+ Agent" request describes — all four shapes the dialog
 * offers, in one place: a remote pane carrying its endpoint, a bare pane
 * running in the workspace cwd, a pane attached to an existing worktree, and
 * one whose worktree does not exist yet (it lands as a provisioning card and
 * the create runs behind it). They were four near-identical branches in the
 * dialog, which is how the sparse-field convention came to be applied three
 * different ways across them.
 *
 * FRESH conversations only. A request that names a session is a resume or a
 * fork; those build their pane around the recorded session instead, and the
 * caller routes them there before reaching this.
 */
export function paneFromAgentRequest(
  id: string,
  request: AgentDialogResult,
  ws: { cwd: string; name: string },
  /** The pane's position for the auto branch name — captured when the dialog
   * opened, not recomputed here: the workspace may have gained panes since. */
  index: number,
): Pane {
  const { agentType, location, remoteEndpoint } = request;
  const name = request.name.trim();
  // Sparse like persistence: only what is set lands on the pane.
  const base: Pane = {
    id,
    ...(name && { name }),
    agentType,
    ...(request.yolo && { yolo: true }),
  };
  // Remote: a bare pane carrying the endpoint. The agent's cwd lives on the
  // box the server runs on, so the local location is moot — the pane's
  // terminal runs the local thin-client attached to the endpoint.
  if (remoteEndpoint) return { ...base, remoteEndpoint };
  // Main repo: a bare pane that runs in the workspace cwd.
  if (location.kind === "main") return base;
  // Existing worktree: attach in place, no git mutation ([F12]-lite).
  if (location.kind === "existing") {
    return {
      ...base,
      cwd: location.path,
      ...(location.branch && { branch: location.branch }),
    };
  }
  // New worktree AT the chosen path, created verbatim with no suffix.
  return {
    ...base,
    provisioning: {
      repo: ws.cwd,
      path: location.path,
      ...(location.branch && { branch: location.branch }),
      ...(location.baseBranch && { base: location.baseBranch }),
      workspace: ws.name,
      index,
    },
  };
}
