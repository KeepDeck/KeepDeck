import type {
  AgentContribution,
  AgentContributionSummary,
} from "@keepdeck/plugin-api";
import {
  AGENT_FEATURE,
  type AgentFeature,
} from "../domain/agents";

/** Execution predicates inspect implementations, not a declaration. They are
 * shared by the plan builder and activation-time manifest validation. */
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

/**
 * Project the manifest's single feature declaration into the live host
 * catalog. Legacy runtime declarations are read only when an old manifest has
 * no feature list; API 30+ registrations reject those duplicate fields.
 */
export function projectAgentFeatures(
  summary: AgentContributionSummary,
  implementation: AgentContribution,
): readonly AgentFeature[] {
  if (summary.features !== undefined) return summary.features;
  return legacyAgentFeatures(implementation);
}

function legacyAgentFeatures(agent: AgentContribution): AgentFeature[] {
  const features: AgentFeature[] = [
    feature(AGENT_FEATURE.newSession, "New sessions", "sessions"),
  ];
  if (contributionSupportsResume(agent)) {
    features.push(
      feature(AGENT_FEATURE.resumeSession, "Resume saved sessions", "sessions"),
    );
  }
  if (contributionSupportsFork(agent)) {
    features.push(
      feature(AGENT_FEATURE.forkSession, "Fork sessions", "sessions"),
    );
  }
  if (contributionSupportsHistory(agent)) {
    features.push(
      feature(AGENT_FEATURE.sessionHistory, "Session history", "sessions"),
    );
  }
  if (agent.usage?.capabilities?.includes("paneTelemetry")) {
    features.push(
      feature(AGENT_FEATURE.paneUsage, "Session analytics", "usage"),
    );
  }
  if (agent.usage?.capabilities?.includes("accountLimits")) {
    features.push(
      feature(AGENT_FEATURE.accountUsage, "Account limits", "usage"),
    );
  }
  if (agent.supportsYolo === true) {
    features.push(feature(AGENT_FEATURE.yolo, "YOLO mode", "execution"));
  }
  if (agent.remote?.mode === "nativeServer" && agent.remote.schemes.length > 0) {
    features.push({
      ...feature(AGENT_FEATURE.remoteTarget, "Remote targets", "execution"),
      parameters: { schemes: agent.remote.schemes },
    });
  }
  return features;
}

function feature(id: string, label: string, group: string): AgentFeature {
  return { id, label, group };
}
