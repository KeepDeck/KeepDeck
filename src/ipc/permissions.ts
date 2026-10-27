import { invoke } from "@tauri-apps/api/core";
import type { Capability } from "@keepdeck/plugin-api";

/** Resolve a manifest's `env` and `net` declarations against the app's
 * startup environment (mirrors the Rust `plugin_permissions_resolve`). The
 * answer is unchecked here; the caller proves its shape. Rejects with a
 * named code when a declaration cannot resolve — never with a value. */
export function resolvePluginPermissions(capabilities: readonly Capability[]): Promise<unknown> {
  return invoke<unknown>("plugin_permissions_resolve", { capabilities });
}
