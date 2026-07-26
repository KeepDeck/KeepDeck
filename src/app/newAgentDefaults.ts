import {
  defaultAgentType,
  type AgentInfo,
  type AgentType,
} from "../domain/agents";
import { firstFreeWorktree, type Workspace } from "../domain/deck";
import { probeWorktree, suggestWorktree } from "../ipc/worktree";
import { getSettings } from "./settingsManager";

/**
 * What a NEW agent in a workspace starts out as, before any surface asks the
 * user to change it.
 *
 * The rules are the product's, not any one surface's: the "+ Agent" dialog
 * prefills them, `agent.spawn` (voice/MCP) applies them unattended, and both
 * had spelled them out character-for-character. A rule with two homes is a
 * rule that changes in one of them.
 */

/**
 * The agent type a new pane starts as: the workspace's own momentum (its last
 * pane's type, if that agent is still selectable) beats the global preference
 * ([F6]), which beats the first installed agent ([F1]).
 *
 * The preference is read here, at the moment of asking — its value matters
 * when the pane is being shaped, not when the app booted.
 */
export function nextAgentType(agents: AgentInfo[], ws: Workspace): AgentType {
  return defaultAgentType(
    agents,
    ws.panes[ws.panes.length - 1]?.agentType ??
      getSettings()?.defaultAgent ??
      "claude",
  );
}

/** The position a new pane takes — the input to its auto branch name. */
export function nextAgentIndex(ws: Workspace): number {
  return ws.panes.length + 1;
}

/**
 * The first worktree location a new pane could take: never one an open pane
 * already runs in, never one blocked on disk. Null when the workspace has no
 * base folder, or when nothing usable could be suggested.
 *
 * Both IPC failures flatten to null deliberately — a suggestion that cannot
 * be made is not an error, it just means no prefill. The create itself is
 * guarded elsewhere.
 */
export function firstFreeAgentWorktree(
  workspaces: Workspace[],
  ws: Workspace,
  index: number,
): Promise<{ path: string; branch: string } | null> {
  if (!ws.worktreeBaseDir) return Promise.resolve(null);
  return firstFreeWorktree(
    workspaces,
    ws.worktreeBaseDir,
    (i) => suggestWorktree(ws.name, i).catch(() => null),
    index,
    (path) => probeWorktree(path).catch(() => null),
  );
}
