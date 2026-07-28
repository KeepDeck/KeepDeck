import type { AgentFeature } from "../../domain/agents";
import type { InstalledPlugin } from "../../plugins";

interface AgentFeaturesSectionProps {
  plugin: InstalledPlugin;
  featureCatalog: readonly AgentFeature[];
}

/**
 * Generic host-owned view over the manifest's single CLI feature declaration.
 * It never needs a new row when the feature vocabulary grows.
 */
export function AgentFeaturesSection({
  plugin,
  featureCatalog,
}: AgentFeaturesSectionProps) {
  if (plugin.manifest.category !== "cli") return null;
  const agents = plugin.manifest.contributes.agents ?? [];

  return (
    <section
      className="settings__agent-features"
      aria-label={`${plugin.manifest.name} features`}
    >
      <h3 className="settings__subheading">CLI features</h3>
      {plugin.status.kind !== "active" && (
        <p className="settings__hint settings__features-status">
          {statusMessage(plugin.status.kind)}
        </p>
      )}
      {agents.length === 0 ? (
        <p className="settings__hint settings__features-empty">
          This integration declares no agents.
        </p>
      ) : (
        <div className="settings__feature-agents">
          {agents.map((agent) => (
            <AgentFeatureCard
              key={agent.id}
              agent={agent}
              featureCatalog={featureCatalog}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function AgentFeatureCard({
  agent,
  featureCatalog,
}: {
  agent: NonNullable<
    InstalledPlugin["manifest"]["contributes"]["agents"]
  >[number];
  featureCatalog: readonly AgentFeature[];
}) {
  return (
    <div className="settings__feature-agent">
      <div className="settings__feature-agent-name">
        <span>{agent.label}</span>
        <span className="settings__hint">{agent.id}</span>
      </div>
      {agent.features === undefined ? (
        <p className="settings__hint settings__features-legacy">
          This plugin uses a legacy API; static feature declarations are
          unavailable.
        </p>
      ) : featureCatalog.length === 0 ? (
        <p className="settings__hint settings__features-empty">
          No CLI features declared.
        </p>
      ) : (
        <dl className="settings__feature-list">
          {featureCatalog.map((catalogFeature) => {
            const declared = agent.features!.find(
              (feature) => feature.id === catalogFeature.id,
            );
            const supported = declared !== undefined;
            return (
              <div className="settings__feature-row" key={catalogFeature.id}>
                <dt title={declared?.description ?? catalogFeature.description}>
                  {declared?.label ?? catalogFeature.label}
                </dt>
                <dd
                  className={
                    supported
                      ? "settings__feature-state settings__feature-state--yes"
                      : "settings__feature-state"
                  }
                >
                  {supported ? "Supported" : "Not supported"}
                  {declared?.parameters
                    ? ` · ${formatParameters(declared.parameters)}`
                    : ""}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
}

function statusMessage(status: InstalledPlugin["status"]["kind"]): string {
  switch (status) {
    case "disabled":
      return "Supported features are declared below; the plugin is disabled.";
    case "unavailable":
      return "Supported features are declared below; the CLI is unavailable.";
    case "failed":
      return "Supported features are declared below; activation failed.";
    case "registered":
      return "Supported features are declared below; activation is pending.";
    case "active":
      return "";
  }
}

function formatParameters(
  parameters: Readonly<Record<string, unknown>>,
): string {
  return Object.entries(parameters)
    .map(([key, value]) => `${key}: ${formatParameter(value)}`)
    .join("; ");
}

function formatParameter(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (value === null) return "none";
  return String(value);
}
