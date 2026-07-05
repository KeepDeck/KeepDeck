import { useSyncExternalStore } from "react";
import type { InstalledPlugin } from "./model/installed";
import type {
  Contribution,
  ContributionRegistry,
} from "./registries/contributions";
import type { PluginHost } from "./host/host";

/**
 * React bridges over the plugin core's external stores. Each is a two-line
 * `useSyncExternalStore` wrapper — the same shape as `src/app/useRunSessions`.
 *
 * They return the full, stable snapshot; a caller that wants only one plugin's
 * or one kind's slice filters IN RENDER. Filtering here would mint a fresh
 * array per call and break the snapshot contract (endless re-render). The
 * registry's `subscribe`/`list` and the host's bound `subscribe`/`getInstalled`
 * are stable references, so the hook never needlessly re-subscribes.
 */

/** Live contributions of one kind, in contribution order. */
export function useContributions<T>(
  registry: ContributionRegistry<T>,
): readonly Contribution<T>[] {
  return useSyncExternalStore(registry.subscribe, registry.list);
}

/** Live installed-plugin snapshot for the Experiments UI. */
export function useInstalledPlugins(
  host: PluginHost,
): readonly InstalledPlugin[] {
  return useSyncExternalStore(host.subscribe, host.getInstalled);
}
