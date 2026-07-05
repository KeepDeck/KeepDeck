import type {
  Disposable,
  PluginContext,
  PluginManifest,
} from "@keepdeck/plugin-api";
import type { ContributionRegistries } from "../registries/contributions";
import type { PluginHostDeps } from "./deps";
import { describeError } from "./errors";

/**
 * Build the `PluginContext` handed to one plugin's `activate`, wired for
 * cleanup by construction.
 *
 * Every `register*` and `on*` the plugin calls returns a `Disposable` that the
 * context TRACKS. Two paths retire a tracked disposable, and they must never
 * collide:
 *
 * - The plugin disposes one early (it kept the handle) → that disposable is
 *   run once and dropped from the set, so `disposeAll` won't touch it again.
 * - The host deactivates (or an activation throws mid-registration) →
 *   `disposeAll` runs whatever remains, exactly once each.
 *
 * `disposeAll` tolerates a disposer that throws: a plugin's teardown is
 * third-party code, and one bad brace must not leak the rest. The failure is
 * logged against the plugin and the sweep continues.
 *
 * The context depends on the narrow ports (`PluginHostDeps`) and the
 * registries, never on the host — so it is exercised in isolation.
 */
export function buildPluginContext(
  manifest: PluginManifest,
  registries: ContributionRegistries,
  deps: PluginHostDeps,
): { ctx: PluginContext; disposeAll(): void } {
  const pluginId = manifest.id;
  const log = deps.log(pluginId);
  const settingsPort = deps.settings(pluginId);

  // The live cleanup set: one entry per outstanding registration, keyed by an
  // identity-stable runner so early disposal and `disposeAll` share one source
  // of truth and can never double-run a disposer.
  const disposers = new Set<() => void>();

  function track(inner: Disposable): Disposable {
    const run = () => inner.dispose();
    disposers.add(run);
    return {
      dispose() {
        // `delete` returns false once already retired → idempotent, and it is
        // what stops `disposeAll` from running an early-disposed brace again.
        if (disposers.delete(run)) run();
      },
    };
  }

  function disposeAll(): void {
    for (const run of [...disposers]) {
      disposers.delete(run);
      try {
        run();
      } catch (error) {
        log.error(`teardown failed: ${describeError(error)}`);
      }
    }
  }

  const ctx: PluginContext = {
    manifest,
    ui: {
      registerDockTab: (tab) => track(registries.dockTabs.add(pluginId, tab)),
      registerTopBarAction: (action) =>
        track(registries.topBarActions.add(pluginId, action)),
      registerPaneAction: (action) =>
        track(registries.paneActions.add(pluginId, action)),
    },
    settings: {
      registerSection: (section) =>
        track(registries.settingsSections.add(pluginId, section)),
      read: () => settingsPort.read(),
      onChange: (cb) => track(settingsPort.onChange(cb)),
    },
    agents: {
      register: (agent) => track(registries.agents.add(pluginId, agent)),
    },
    storage: deps.storage(pluginId),
    events: {
      onWorkspaceClosed: (cb) => track(deps.events.onWorkspaceClosed(cb)),
      onPaneSelected: (cb) => track(deps.events.onPaneSelected(cb)),
      onDeckChanged: (cb) => track(deps.events.onDeckChanged(cb)),
    },
    services: deps.services(manifest),
    log,
  };

  return { ctx, disposeAll };
}
