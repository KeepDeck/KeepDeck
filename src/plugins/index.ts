/**
 * The plugin host framework — the surface the host app imports to run plugins.
 *
 * Pure host-side wiring: the install model, the contribution registries, the
 * lifecycle host, the context builder, the ports it needs, and the React
 * bridges. It knows the contract (`@keepdeck/plugin-api`) and nothing of the
 * backends — storage, settings, services, and logging all arrive through
 * `PluginHostDeps`, so the app supplies real implementations and tests supply
 * fakes.
 */

export {
  orderBySource,
  type InstalledPlugin,
  type PluginSource,
  type PluginStatus,
} from "./model/installed";

export {
  createContributionRegistries,
  createContributionRegistry,
  type Contribution,
  type ContributionRegistries,
  type ContributionRegistry,
} from "./registries/contributions";

export type { PluginHostDeps } from "./host/deps";
export { buildPluginContext } from "./host/context";
export { PluginHost, type PluginInstall } from "./host/host";

export { useContributions, useInstalledPlugins } from "./react";
