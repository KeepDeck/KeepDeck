/** The runtime half of a plugin: the context handed to `activate` and the
 * role interfaces it aggregates — one module per concern. */
export type {
  AgentContribution,
  AgentHooks,
  PluginAgents,
  ResumePlanInput,
  SpawnPlanInput,
  SpawnPlanOutput,
} from "./agents.ts";
export type { PluginContext } from "./context.ts";
export type { Disposable } from "./disposable.ts";
export type { PluginEvents } from "./events.ts";
export type { HostSettingsSnapshot, PluginHostFacts } from "./hostFacts.ts";
export type { PluginLogger } from "./log.ts";
export type {
  FileOpenHandler,
  FileOpenRequest,
  PluginFileOpeners,
} from "./openers.ts";
export type { KeepDeckPlugin } from "./plugin.ts";
export type {
  FsEntry,
  FsEntryKind,
  FsFile,
  FsReadFileOptions,
  PluginFs,
  PluginOpener,
  PluginPorts,
  PluginServices,
  PluginSessionEvent,
  PluginSessionHandle,
  PluginSessions,
  PluginSpawnOptions,
} from "./services.ts";
export type {
  PluginSettings,
  SettingsField,
  SettingsSectionContribution,
} from "./settings.ts";
export type { PaneSnapshot, WorkspaceSnapshot } from "./snapshots.ts";
export type { PluginResources } from "./resources.ts";
export type { PluginKV, PluginStorage } from "./storage.ts";
export type {
  DockTabContribution,
  DockTabProps,
  OverlayContribution,
  PaneActionContribution,
  PluginUi,
  TopBarActionContribution,
} from "./ui.ts";
