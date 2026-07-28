import type { AgentContribution } from "@keepdeck/plugin-api";

/** Runtime implementation predicates shared by the plugin host and app. */
export function contributionSupportsResume(
  agent: AgentContribution,
): boolean {
  return typeof agent.hooks["resume.plan"] === "function";
}

export function contributionSupportsFork(agent: AgentContribution): boolean {
  return typeof agent.hooks["fork.plan"] === "function";
}

export function contributionSupportsHistory(
  agent: AgentContribution,
): boolean {
  return agent.history !== undefined;
}
