import { AGENT_FEATURE, agentsDeclaring, type AgentInfo } from "../domain/agents";

/**
 * The words that say which agents a library item or a setting reaches —
 * built from the catalog, so an agent's plugin is the only place that says
 * it takes MCP servers, skills or a remote target, and the host never lists
 * agents by name.
 */

/** "A", "A and B", "A, B and C" — the agents' own labels. */
export function agentLabelList(agents: readonly Pick<AgentInfo, "label">[]): string {
  const labels = agents.map((agent) => agent.label);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** The MCP library's placeholder line. */
export function mcpReachHint(agents: readonly AgentInfo[]): string {
  const reached = agentsDeclaring(agents, AGENT_FEATURE.mcpServers);
  return reached.length > 0
    ? `Pick a server on the left or create one — it reaches ${agentLabelList(reached)} panes at their next session`
    : "Pick a server on the left or create one — no installed agent takes MCP servers yet";
}

/** The skills library's placeholder line. */
export function skillsReachHint(agents: readonly AgentInfo[]): string {
  const reached = agentsDeclaring(agents, AGENT_FEATURE.skills);
  return reached.length > 0
    ? `Pick a skill on the left or create one — it reaches ${agentLabelList(reached)} worktrees at their next session`
    : "Pick a skill on the left or create one — no installed agent takes skills yet";
}

/** The Remote agents setting's hint: which agents can run against a remote
 * endpoint, when any can. */
export function remoteAgentsHint(agents: readonly AgentInfo[]): string {
  const remote = agentsDeclaring(agents, AGENT_FEATURE.remoteTarget);
  const which = remote.length > 0 ? ` (${agentLabelList(remote)})` : "";
  return (
    `Lets an agent that speaks a client/server protocol${which} run against a remote ` +
    "endpoint from the “Add member” dialog’s Where option. Off by default — the feature is experimental."
  );
}
