import { projectAgentFeatureRows } from "../../app/agentFeatureCatalog";
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
              showAgentName={agents.length > 1}
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
  showAgentName,
}: {
  agent: NonNullable<
    InstalledPlugin["manifest"]["contributes"]["agents"]
  >[number];
  featureCatalog: readonly AgentFeature[];
  showAgentName: boolean;
}) {
  return (
    <div className="settings__feature-agent">
      {showAgentName && (
        <div className="settings__feature-agent-name">{agent.label}</div>
      )}
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
          {projectAgentFeatureRows(featureCatalog, agent.features).map((row) => (
            <div className="settings__feature-row" key={row.id}>
              <dt title={row.description}>{row.label}</dt>
              <dd
                className={
                  row.supported
                    ? "settings__feature-state settings__feature-state--yes"
                    : "settings__feature-state"
                }
                title={row.stateText}
              >
                {row.stateText}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
