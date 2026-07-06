/**
 * The external tier's origin scheme. Every installed external plugin is
 * served by the Rust `kdplugin` protocol handler under its OWN host —
 * `kdplugin://<plugin-id>/<path>` — so two plugins are two origins and the
 * browser's same-origin policy is the isolation primitive (the Logseq/Figma
 * model). The plugin-id grammar (lowercase, dots/hyphens) is URL-host-safe
 * by construction. This module is the single TS source of the scheme name;
 * the Rust handler registers the same literal.
 */
export const EXTERNAL_PLUGIN_SCHEME = "kdplugin";

/** Absolute URL of a file inside an external plugin's install folder. */
export function externalPluginUrl(pluginId: string, path: string): string {
  return `${EXTERNAL_PLUGIN_SCHEME}://${pluginId}/${path.replace(/^\/+/, "")}`;
}
