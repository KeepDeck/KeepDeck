import type { AgentFeature, AgentFeatureParameter } from "../domain/agents";
import type { InstalledPlugin } from "../plugins";

export interface AgentFeatureRow {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly supported: boolean;
  readonly stateText: string;
}

/**
 * Union of self-describing manifest features. Source ordering cannot affect
 * which descriptor owns a duplicate id: plugin id and agent id are the stable
 * tie-breakers, so rescans always produce the same catalog.
 */
export function buildAgentFeatureCatalog(
  installed: readonly InstalledPlugin[],
): AgentFeature[] {
  const declarations = installed.flatMap((plugin) =>
    (plugin.manifest.contributes.agents ?? []).flatMap((agent) =>
      (agent.features ?? []).map((feature) => ({
        pluginId: plugin.manifest.id,
        agentId: agent.id,
        feature,
      })),
    ),
  );
  declarations.sort(
    (a, b) =>
      a.pluginId.localeCompare(b.pluginId) ||
      a.agentId.localeCompare(b.agentId) ||
      a.feature.id.localeCompare(b.feature.id),
  );

  const catalog = new Map<string, AgentFeature>();
  for (const declaration of declarations) {
    if (!catalog.has(declaration.feature.id))
      catalog.set(declaration.feature.id, declaration.feature);
  }
  return [...catalog.values()].sort(
    (a, b) =>
      (a.group ?? "").localeCompare(b.group ?? "") ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id),
  );
}

/** Join one agent's declaration to the shared catalog for presentation. */
export function projectAgentFeatureRows(
  catalog: readonly AgentFeature[],
  declared: readonly AgentFeature[],
): AgentFeatureRow[] {
  const declarations = new Map(declared.map((feature) => [feature.id, feature]));
  return catalog
    .map((catalogFeature) => {
      const declaration = declarations.get(catalogFeature.id);
      const supported = declaration !== undefined;
      const parameterText = declaration?.parameters
        ? formatFeatureParameters(declaration.parameters)
        : "";
      return {
        id: catalogFeature.id,
        label: declaration?.label ?? catalogFeature.label,
        description: declaration?.description ?? catalogFeature.description,
        supported,
        stateText: supported
          ? `Supported${parameterText ? ` · ${parameterText}` : ""}`
          : "Not supported",
      };
    })
    .sort((a, b) => Number(b.supported) - Number(a.supported));
}

function formatFeatureParameters(
  parameters: Readonly<Record<string, AgentFeatureParameter>>,
): string {
  return Object.entries(parameters)
    .map(([key, value]) => `${key}: ${formatFeatureParameter(value)}`)
    .join("; ");
}

function formatFeatureParameter(value: AgentFeatureParameter): string {
  if (Array.isArray(value))
    return value.length > 0
      ? value.map((item) => formatFeatureParameter(item)).join(", ")
      : "none";
  if (value === null) return "none";
  return String(value);
}
