import { invoke } from "@tauri-apps/api/core";
import type { Capability } from "@keepdeck/plugin-api";

/** Resolve a manifest's `env` and `net` declarations against the app's
 * startup environment (mirrors the Rust `plugin_permissions_resolve`), and
 * keep the result natively as the plugin's grant — the one its HTTP requests
 * are held to. The answer is unchecked here; the caller proves its shape.
 * Rejects with a named code when a declaration cannot resolve — never with a
 * value — and the plugin is then left with no grant. */
export function resolvePluginPermissions(
  pluginId: string,
  capabilities: readonly Capability[],
): Promise<unknown> {
  return invoke<unknown>("plugin_permissions_resolve", { pluginId, capabilities });
}

/** Drop a plugin's native grant: it declares nothing any more, or it is gone. */
export function forgetPluginPermissions(pluginId: string): Promise<void> {
  return invoke<void>("plugin_permissions_forget", { pluginId });
}
