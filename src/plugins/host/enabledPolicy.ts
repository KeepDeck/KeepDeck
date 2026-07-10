import type { PluginCategory } from "@keepdeck/plugin-api";
import type { PluginSource } from "../model/installed";

/**
 * The default-enabled policy, given a plugin's stored flag and what kind of
 * plugin it is. An explicit stored choice always wins. Without one:
 *
 * - built-in CLI agents are ON — they are the deck's reason to exist, and a
 *   fresh install with every agent off is an empty picker;
 * - everything else (deck plugins, ALL external plugins) is opt-in —
 *   nothing visual or third-party activates on its own.
 *
 * External consent (the capability fingerprint) is a separate check layered
 * on top by the caller; this is only the enabled flag's resolution.
 */
export function enabledByPolicy(
  stored: boolean | undefined,
  source: PluginSource,
  category: PluginCategory,
): boolean {
  if (stored !== undefined) return stored === true;
  return source === "builtin" && category === "cli";
}
