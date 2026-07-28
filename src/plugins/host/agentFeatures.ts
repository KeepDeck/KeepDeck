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
} from "../../app/agentCapabilities";

/**
 * Validate the manifest's one feature declaration against concrete runtime
 * ports. Runtime objects never repeat the feature ids for API 30+ plugins.
 */
export function validateAgentFeatureImplementations(
  summary: AgentContributionSummary,
  implementation: AgentContribution,
): void {
  if (summary.features === undefined) return; // legacy contract

  rejectLegacyDeclarations(implementation);
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

  validateUsageFeatures(summary.features, implementation);
  validateRemoteFeature(summary.features, implementation.id);
}

interface FeatureContract {
  id: string;
  implemented: boolean;
  port: string;
}

function validateUsageFeatures(
  features: readonly AgentFeatureDeclaration[],
  implementation: AgentContribution,
): void {
  const pane = features.some((feature) => feature.id === AGENT_FEATURE.paneUsage);
  const account = features.some(
    (feature) => feature.id === AGENT_FEATURE.accountUsage,
  );
  if ((pane || account) && implementation.usage === undefined) {
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

function rejectLegacyDeclarations(implementation: AgentContribution): void {
  if (implementation.supportsYolo !== undefined) {
    throw duplicateDeclaration(implementation.id, "supportsYolo");
  }
  if (implementation.remote !== undefined) {
    throw duplicateDeclaration(implementation.id, "remote");
  }
  if (implementation.usage?.capabilities !== undefined) {
    throw duplicateDeclaration(implementation.id, "usage.capabilities");
  }
}

function duplicateDeclaration(agentId: string, field: string): Error {
  return new Error(
    `agent "${agentId}": runtime ${field} duplicates the manifest feature declaration`,
  );
}
