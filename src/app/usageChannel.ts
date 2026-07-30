import type {
  AgentContribution,
  AgentUsage,
} from "@keepdeck/plugin-api";
import type { ContributionRegistry } from "../plugins/registries/contributions";
import type { DeckStore } from "./deckStore";
import { registerUsageNormalizer } from "./usageManager";
import { createUsageLimitsLane } from "./usageChannelLimits";
import { createUsageMaintenanceLane } from "./usageChannelMaintenance";
import { createUsageReportsLane } from "./usageChannelReports";
import type {
  UsageDeclarations,
  UsageLane,
} from "./usageChannelSource";
import { createUsageTailsLane } from "./usageChannelTails";

export interface UsageChannel {
  dispose(): void;
}

/** App-lifetime composition of all declared usage ingestion lanes. */
export function createUsageChannel(
  deck: DeckStore,
  agents: ContributionRegistry<AgentContribution>,
): UsageChannel {
  const declarationListeners = new Set<() => void>();
  let usageByAgent = readDeclarations();
  let normalizerDisposers: (() => void)[] = [];
  let disposed = false;

  function readDeclarations(): ReadonlyMap<string, AgentUsage> {
    const declarations = new Map<string, AgentUsage>();
    for (const { entry } of agents.list()) {
      if (entry.usage) declarations.set(entry.id, entry.usage);
    }
    return declarations;
  }

  const declarations: UsageDeclarations = {
    current: () => usageByAgent,
    subscribe(listener) {
      declarationListeners.add(listener);
      return () => declarationListeners.delete(listener);
    },
  };

  const registerNormalizers = () => {
    for (const unregister of normalizerDisposers) unregister();
    normalizerDisposers = [...usageByAgent].map(([agentId, usage]) =>
      registerUsageNormalizer(agentId, usage.normalize),
    );
  };

  const contributionsChanged = () => {
    if (disposed) return;
    usageByAgent = readDeclarations();
    registerNormalizers();
    for (const listener of [...declarationListeners]) listener();
  };

  registerNormalizers();
  const context = { deck, declarations };
  const lanes: UsageLane[] = [
    createUsageReportsLane(context),
    createUsageTailsLane(context),
    createUsageLimitsLane(context),
    createUsageMaintenanceLane(context),
  ];
  const unsubscribeAgents = agents.subscribe(contributionsChanged);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeAgents();
      for (const lane of lanes) lane.dispose();
      for (const unregister of normalizerDisposers) unregister();
      normalizerDisposers = [];
      declarationListeners.clear();
    },
  };
}
