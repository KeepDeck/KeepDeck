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
import type { AgentDialogResult } from "../../agents";
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
  request: AgentDialogResult,
  ws: { cwd: string },
  /** The pane's position for the auto branch name — captured when the dialog
   * opened, not recomputed here: the workspace may have gained panes since. */
  index: number,
): PaneRequest {
  const { agentType, location, remoteEndpoint } = request;
  const name = request.name.trim();
  // Sparse like persistence: only what is set lands on the pane.
  const pane: Pane = {
    id,
    ...(name && { name }),
    agentType,
    ...(request.yolo && { yolo: true }),
  };
  // The root is a directory like any other: the team on it holds it.
  const root: TeamLocation = { kind: "attached", cwd: ws.cwd };
  // Remote: a bare pane carrying the endpoint. The agent's cwd lives on the
  // box the server runs on, so the local directory is moot — the pane's
  // terminal runs the local thin-client attached to the endpoint, in the
  // root's team.
  if (remoteEndpoint) {
    return {
      pane: { ...pane, location: { kind: "remote", endpoint: remoteEndpoint } },
      placement: root,
    };
  }
  // Main repo: the pane joins the team on the workspace root.
  if (location.kind === "main") return { pane, placement: root };
  // Existing worktree: attach in place, no git mutation ([F12]-lite).
  if (location.kind === "existing") {
    return {
      pane,
      placement: {
        kind: "attached",
        cwd: location.path,
        ...(location.branch && { branch: location.branch }),
      },
    };
  }
  // New worktree AT the chosen path, created verbatim with no suffix.
  return {
    pane,
    placement: {
      kind: "provisioning",
      intent: {
        repo: ws.cwd,
        path: location.path,
        ...(location.branch && { branch: location.branch }),
        ...(location.baseBranch && { base: location.baseBranch }),
        index,
      },
    },
  };
}
