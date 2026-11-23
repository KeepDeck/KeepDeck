import {
  defaultAgentType,
  type AgentInfo,
  type AgentType,
} from "../domain/agents";
import type { Workspace } from "../domain/deck";
import { getSettings } from "./settingsManager";

/**
 * What a NEW agent in a workspace starts out as, before any surface asks the
 * user to change it.
 *
 * The rules are the product's, not any one surface's: the agent dialog
 * prefills them, `agent.spawn` (voice/MCP) applies them unattended, and both
 * had spelled them out character-for-character. A rule with two homes is a
 * rule that changes in one of them. Where a new team's worktree goes is not
 * among them: that place is the lifecycle machine's to suggest
 * (`lifecycle_location`).
 */

/**
 * Whether a fresh agent starts with YOLO on: the global preference, read at
 * the moment of asking. One that continues a session starts as that session
 * ran instead ([`startingYolo`]), which only the surface holding the session
 * can ask.
 */
export function nextYolo(): boolean {
  return getSettings()?.defaultYolo ?? false;
}

/**
 * The agent type a new pane starts as: the workspace's own momentum (its last
 * pane's type, if that agent is still selectable) beats the global preference
 * ([F6]), which beats the first installed agent ([F1]).
 *
 * The preference is read here, at the moment of asking — its value matters
 * when the pane is being shaped, not when the app booted.
 */
export function nextAgentType(agents: AgentInfo[], ws: Workspace): AgentType | null {
  return defaultAgentType(
    agents,
    ws.panes[ws.panes.length - 1]?.agentType ?? getSettings()?.defaultAgent ?? null,
  );
}
