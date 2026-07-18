import { useEffect } from "react";
import type { AgentUsage } from "@keepdeck/plugin-api";
import { registerUsageNormalizer } from "./usageManager";

/** Keep the store's normalizer registrations in lockstep with plugin
 * activation: each agent's `usage.normalize` is registered while its
 * contribution lives and disposed when it goes. */
export function useUsageNormalizers(
  usageByAgent: ReadonlyMap<string, AgentUsage>,
): void {
  useEffect(() => {
    const disposers = [...usageByAgent].map(([id, usage]) =>
      registerUsageNormalizer(id, usage.normalize),
    );
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [usageByAgent]);
}
