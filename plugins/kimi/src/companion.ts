import companionManifest from "../resources/keepdeck-session-reporter/kimi.plugin.json";
import type { KimiCompanionDescriptor } from "./manager";

export const COMPANION_ID = companionManifest.name;
export const COMPANION_VERSION = companionManifest.version;
export const COMPANION_RESOURCE_DIRECTORY = "keepdeck-session-reporter";
export const COMPANION_MANIFEST_RESOURCE =
  `${COMPANION_RESOURCE_DIRECTORY}/kimi.plugin.json` as const;

export const COMPANION_DESCRIPTOR = {
  id: COMPANION_ID,
  version: COMPANION_VERSION,
  displayName: companionManifest.interface.displayName,
  resourceDirectoryName: COMPANION_RESOURCE_DIRECTORY,
  hookCount: companionManifest.hooks.length,
} satisfies KimiCompanionDescriptor;

/** PluginResources resolves files, while Kimi installs a directory. Derive
 * the containing folder without importing Node path utilities into the web
 * plugin bundle; both native separators are accepted. */
export function parentDirectory(path: string): string | null {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator > 0 ? path.slice(0, separator) : null;
}
