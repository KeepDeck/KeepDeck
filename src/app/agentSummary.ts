import type { AgentContribution, AgentContributionSummary } from "@keepdeck/plugin-api";
import type { InstalledPlugin } from "../plugins";

/**
 * What an agent's plugin declares for it in its manifest — its static
 * summary, features included — found by the plugin that registered it. A
 * contribution whose manifest says nothing of it (it never should) reads as
 * a summary with no features rather than not at all.
 */
export function agentSummary(
  installed: readonly InstalledPlugin[],
  pluginId: string,
  implementation: Pick<AgentContribution, "id" | "label" | "detect">,
): AgentContributionSummary {
  return (
    installed
      .find((plugin) => plugin.manifest.id === pluginId)
      ?.manifest.contributes.agents?.find((summary) => summary.id === implementation.id) ?? {
      id: implementation.id,
      label: implementation.label,
      bin: implementation.detect.bin,
      features: [],
    }
  );
}
