import type {
  AgentContribution,
  AgentContributionSummary,
  AgentFeatureDeclaration,
} from "@keepdeck/plugin-api";
import { AGENT_FEATURE } from "../../domain/agents";
import {
  contributionSupportsFork,
  contributionSupportsHistory,
  contributionSupportsResume,
} from "../agents/implementation";

/**
 * Validate the manifest's one feature declaration against concrete runtime
 * ports. Runtime objects never repeat the feature ids for API 30+ plugins.
 */
export function validateAgentFeatureImplementations(
  summary: AgentContributionSummary,
  implementation: AgentContribution,
  options: { external?: boolean } = {},
): void {
  const declared = new Set(summary.features.map((feature) => feature.id));
  const contracts: readonly FeatureContract[] = [
    {
      id: AGENT_FEATURE.newSession,
      implemented: typeof implementation.hooks["spawn.plan"] === "function",
      port: "spawn.plan",
    },
    {
      id: AGENT_FEATURE.resumeSession,
      implemented: contributionSupportsResume(implementation),
      port: "resume.plan",
    },
    {
      id: AGENT_FEATURE.forkSession,
      implemented: contributionSupportsFork(implementation),
      port: "fork.plan",
    },
    {
      id: AGENT_FEATURE.sessionHistory,
      implemented: contributionSupportsHistory(implementation),
      port: "history provider",
    },
  ];

  for (const contract of contracts) {
    const claimsSupport = declared.has(contract.id);
    if (claimsSupport === contract.implemented) continue;
    if (claimsSupport) {
      throw new Error(
        `agent "${implementation.id}": manifest feature "${contract.id}" requires a ${contract.port} implementation`,
      );
    }
    throw new Error(
      `agent "${implementation.id}": ${contract.port} implementation requires manifest feature "${contract.id}"`,
    );
  }

  validateRemoteFeature(summary.features, implementation.id);
  requireSpawnPlan(summary.features, implementation, AGENT_FEATURE.yolo);
  requireSpawnPlan(
    summary.features,
    implementation,
    AGENT_FEATURE.remoteTarget,
  );
  validateUsageFeatures(
    summary.features,
    implementation,
    options.external === true,
  );
}

interface FeatureContract {
  id: string;
  implemented: boolean;
  port: string;
}

function validateUsageFeatures(
  features: readonly AgentFeatureDeclaration[],
  implementation: AgentContribution,
  external: boolean,
): void {
  const pane = features.some((feature) => feature.id === AGENT_FEATURE.paneUsage);
  const account = features.some(
    (feature) => feature.id === AGENT_FEATURE.accountUsage,
  );
  if (
    (pane || account) &&
    implementation.usage === undefined &&
    !external
  ) {
    throw new Error(
      `agent "${implementation.id}": usage features require a usage implementation`,
    );
  }
  if (!pane && !account && implementation.usage !== undefined) {
    throw new Error(
      `agent "${implementation.id}": usage implementation requires a manifest usage feature`,
    );
  }
  if (implementation.usage?.limits !== undefined && !account) {
    throw new Error(
      `agent "${implementation.id}": limits implementation requires manifest feature "${AGENT_FEATURE.accountUsage}"`,
    );
  }
}

function requireSpawnPlan(
  features: readonly AgentFeatureDeclaration[],
  implementation: AgentContribution,
  featureId: string,
): void {
  if (
    features.some((feature) => feature.id === featureId) &&
    typeof implementation.hooks["spawn.plan"] !== "function"
  ) {
    throw new Error(
      `agent "${implementation.id}": manifest feature "${featureId}" requires a spawn.plan implementation`,
    );
  }
}

function validateRemoteFeature(
  features: readonly AgentFeatureDeclaration[],
  agentId: string,
): void {
  const remote = features.find(
    (feature) => feature.id === AGENT_FEATURE.remoteTarget,
  );
  if (!remote) return;
  const schemes = remote.parameters?.schemes;
  if (
    !Array.isArray(schemes) ||
    schemes.length === 0 ||
    schemes.some(
      (scheme) =>
        scheme !== "ws" &&
        scheme !== "wss" &&
        scheme !== "http" &&
        scheme !== "https",
    )
  ) {
    throw new Error(
      `agent "${agentId}": manifest feature "${AGENT_FEATURE.remoteTarget}" requires non-empty supported "schemes"`,
    );
  }
}
