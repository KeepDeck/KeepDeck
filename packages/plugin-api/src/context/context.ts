import type { PluginAgents } from "./agents.ts";
import type { PluginEvents } from "./events.ts";
import type { PluginHostFacts } from "./hostFacts.ts";
import type { PluginLogger } from "./log.ts";
import type { PluginManifest } from "../manifest/manifest.ts";
import type { PluginServices } from "./services.ts";
import type { PluginSettings } from "./settings.ts";
import type { PluginStorage } from "./storage.ts";
import type { PluginUi } from "./ui.ts";

/**
 * The plugin context — everything a plugin may touch, handed to `activate`.
 * An aggregate of role interfaces (one per concern module); host code and
 * plugins alike depend on the narrow role, never on this aggregate, except
 * at the activation boundary itself.
 *
 * Two rules shape every member:
 *
 * 1. **Transport-agnostic**: all inputs and outputs are serializable data and
 *    all service calls are async, so the same contract runs in-process
 *    (built-in tier) and over postMessage RPC (external tier, sandboxed).
 *    Nothing here hands out a live core object.
 * 2. **Cleanup by construction**: every `register*` and `on*` returns a
 *    `Disposable`, and the host disposes ALL of them at deactivation.
 */
export interface PluginContext {
  readonly manifest: PluginManifest;
  readonly ui: PluginUi;
  readonly settings: PluginSettings;
  readonly agents: PluginAgents;
  readonly storage: PluginStorage;
  readonly events: PluginEvents;
  readonly services: PluginServices;
  readonly host: PluginHostFacts;
  readonly log: PluginLogger;
}
