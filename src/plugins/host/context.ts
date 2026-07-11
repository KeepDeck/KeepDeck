import type {
  Disposable,
  PluginContext,
  PluginManifest,
} from "@keepdeck/plugin-api";
import { execCovers } from "../capabilities/execCovers";
import type { ContributionRegistries } from "../registries/contributions";
import type { PluginSource } from "../model/installed";
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
  source: PluginSource,
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

  // Registration is bounded by the manifest: only DECLARED contributions may
  // register (the same fail-closed idiom the capability gate applies to
  // services). A mismatch throws — activation catches it, the plugin lands
  // `failed` with zero residue, and the author reads exactly what to fix.
  function declared(
    kind: keyof PluginManifest["contributes"],
    id: string,
  ): void {
    const list = manifest.contributes[kind];
    if (Array.isArray(list) && list.some((s) => s.id === id)) return;
    throw new Error(
      `contribution not declared in the manifest: ${kind} "${id}"`,
    );
  }

  const ctx: PluginContext = {
    manifest,
    ui: {
      registerDockTab: (tab) => {
        declared("dockTabs", tab.id);
        return track(registries.dockTabs.add(pluginId, tab));
      },
      registerTopBarAction: (action) => {
        declared("topBarActions", action.id);
        return track(registries.topBarActions.add(pluginId, action));
      },
      registerPaneAction: (action) => {
        declared("paneActions", action.id);
        return track(registries.paneActions.add(pluginId, action));
      },
      revealDockTab: (id) => deps.ui.revealDockTab(pluginId, id),
    },
    openers: {
      register: (handler) => {
        declared("fileOpeners", handler.id);
        return track(registries.fileOpeners.add(pluginId, handler));
      },
    },
    settings: {
      registerSection: (section) => {
        if (manifest.contributes.settings !== true) {
          throw new Error(
            "contribution not declared in the manifest: settings",
          );
        }
        return track(registries.settingsSections.add(pluginId, section));
      },
      read: () => settingsPort.read(),
      onChange: (cb) => track(settingsPort.onChange(cb)),
    },
    agents: {
      register: (agent) => {
        declared("agents", agent.id);
        // The agent's binary is what spawn plans fall back to — it must be
        // legitimate by declaration, both tiers, no exceptions.
        if (!execCovers(manifest.capabilities, agent.detect.bin)) {
          throw new Error(
            `agent "${agent.id}": detect.bin "${agent.detect.bin}" is not covered by an exec capability`,
          );
        }
        return track(registries.agents.add(pluginId, agent));
      },
    },
    storage: deps.storage(pluginId),
    resources: deps.resources(manifest, source),
    events: {
      onWorkspaceClosed: (cb) => track(deps.events.onWorkspaceClosed(cb)),
      onPaneSelected: (cb) => track(deps.events.onPaneSelected(cb)),
      onDeckChanged: (cb) => track(deps.events.onDeckChanged(cb)),
    },
    services: deps.services(manifest, source),
    host: deps.hostFacts,
    log,
  };

  return { ctx, disposeAll };
}
