import type {
  PluginEvents,
  PluginHostFacts,
  PluginLogger,
  PluginResources,
  PluginManifest,
  PluginServices,
  PluginSettings,
  PluginStorage,
} from "@keepdeck/plugin-api";
import type { PluginSource } from "../model/installed";

/**
 * The ports the plugin core needs from the app — dependency inversion in one
 * interface. The core owns the registries, the context wiring, and the
 * lifecycle; it owns NONE of the backends. Storage, settings values,
 * platform services, and the log all arrive through these functions, so tests
 * hand the host cheap `vi.fn` fakes and the real app hands it the Tauri-backed
 * implementations — the core code is identical in both.
 *
 * Everything is per-plugin because everything the contract exposes is
 * namespaced by plugin id (or gated by the plugin's manifest). The core threads
 * identity through; the dep decides what that identity is allowed to touch.
 */
export interface PluginHostDeps {
  /** This plugin's namespaced persistence (workspace + global KV). */
  storage(pluginId: string): PluginStorage;
  /**
   * This plugin's settings VALUES only — `registerSection` is the core's job
   * (it lands in the contributions registry), so the dep supplies just the
   * read side and the change feed.
   */
  settings(pluginId: string): Pick<PluginSettings, "read" | "onChange">;
  /** The single global deck-event source. The context wraps it per plugin so
   * each subscription is tracked and torn down on deactivation — the dep need
   * not know about any plugin. */
  events: PluginEvents;
  /** Platform services for a plugin. The manifest is threaded through so the
   * capability gate (built inside this dep, not here) can refuse a call the
   * plugin never declared; `source` picks the gate's TIER — a trusted
   * built-in warns on a violation, an untrusted external throws (enforce). */
  services(manifest: PluginManifest, source: PluginSource): PluginServices;
  /** This plugin's bundle resources (absolute on-disk paths). `source`
   * picks the backing: built-ins resolve inside the app bundle, externals
   * inside their install folder. */
  resources(manifest: PluginManifest, source: PluginSource): PluginResources;
  /** Host UI actions a context forwards verbatim (identity threaded so the
   * host can namespace — a dock tab's full id is `pluginId:entryId`). */
  ui: {
    /** Open the dock on the active workspace with this plugin's tab selected. */
    revealDockTab(pluginId: string, entryId: string): void;
    /** Show/hide one of this plugin's overlays (see `PluginUi`). */
    setOverlayVisible(pluginId: string, entryId: string, visible: boolean): void;
  };
  /** This plugin's logger — lines land in the shared log namespaced by id. */
  log(pluginId: string): PluginLogger;
  /** Read-only whitelisted host facts, shared by every plugin. */
  hostFacts: PluginHostFacts;
  /**
   * Whether a plugin is enabled, read once at install to seed its status.
   * Absent → enabled by default. PERSISTENCE of the flag lives outside the
   * core (this port reads it, `onEnabledChanged` writes it back).
   */
  isEnabled?(pluginId: string): boolean;
  /** Fired when `setEnabled` flips a plugin's enabled flag, so the owner can
   * persist it. The core keeps no store of its own. */
  onEnabledChanged?(pluginId: string, enabled: boolean): void;
}
