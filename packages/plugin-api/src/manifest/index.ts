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
export { hasUnsafeText, stripUnsafeText } from "./text.ts";
export {
  API_VERSION,
  isApiVersion,
  parseVersion,
  satisfiesApiFloor,
} from "./version.ts";
