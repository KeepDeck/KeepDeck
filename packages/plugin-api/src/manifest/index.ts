/** The static half of a plugin: manifest, capabilities, API floor — what the
 * host reads and validates BEFORE any plugin code runs. */
export { CAPABILITY_KINDS, type Capability } from "./capabilities.ts";
export {
  readManifest,
  type ContributionSummary,
  type ManifestResult,
  type PluginCategory,
  type PluginManifest,
} from "./manifest.ts";
// Only the PREDICATE is contract surface (the manifest-name rule plugin
// authors validate against). The `strip` variant is the HOST's sanitizer —
// deliberately not advertised here ("the host sanitizes, the plugin
// doesn't"); host code reaches it via the `unsafe-text` subpath.
export { hasUnsafeText } from "./text.ts";
export {
  API_VERSION,
  isApiVersion,
  parseVersion,
  satisfiesApiFloor,
} from "./version.ts";
