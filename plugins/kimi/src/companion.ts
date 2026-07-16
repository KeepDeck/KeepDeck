export const COMPANION_ID = "keepdeck-session-reporter";
export const COMPANION_VERSION = "1.0.0";
export const COMPANION_MANIFEST_RESOURCE =
  `${COMPANION_ID}/kimi.plugin.json` as const;

/** PluginResources resolves files, while Kimi installs a directory. Derive
 * the containing folder without importing Node path utilities into the web
 * plugin bundle; both native separators are accepted. */
export function parentDirectory(path: string): string | null {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator > 0 ? path.slice(0, separator) : null;
}
