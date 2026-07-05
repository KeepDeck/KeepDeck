/**
 * @keepdeck/plugin-api — the contract KeepDeck plugins build against.
 *
 * Plugins bundle with this package (and react) marked EXTERNAL; at runtime
 * the host's import map resolves both to the host's own copies, so a plugin
 * component shares the host React instance. The contract is deliberately
 * transport-agnostic (see `context.ts`): the built-in tier calls it
 * in-process, the external tier speaks it over postMessage RPC.
 */
export { API_VERSION, parseVersion, satisfiesApiFloor } from "./version.ts";
export { CAPABILITY_KINDS, type Capability } from "./capabilities.ts";
export {
  readManifest,
  type ManifestResult,
  type PluginManifest,
} from "./manifest.ts";
export type { KeepDeckPlugin } from "./plugin.ts";
export type {
  AgentContribution,
  AgentHooks,
  Disposable,
  DockTabContribution,
  DockTabProps,
  PaneActionContribution,
  PaneSnapshot,
  PluginAgents,
  PluginContext,
  PluginEvents,
  PluginKV,
  PluginLogger,
  PluginPorts,
  PluginServices,
  PluginSessionEvent,
  PluginSessionHandle,
  PluginSessions,
  PluginSettings,
  PluginSpawnOptions,
  PluginStorage,
  PluginUi,
  ResumePlanInput,
  SettingsField,
  SettingsSectionContribution,
  SpawnPlanInput,
  SpawnPlanOutput,
  TopBarActionContribution,
  WorkspaceSnapshot,
} from "./context.ts";
