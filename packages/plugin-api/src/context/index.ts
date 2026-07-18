/** The runtime half of a plugin: the context handed to `activate` and the
 * role interfaces it aggregates — one module per concern. */
export type {
  AgentContribution,
  AgentHooks,
  AgentIcon,
  AgentIconPath,
  PluginAgents,
  ResumePlanInput,
  SpawnPlanInput,
  SpawnPlanOutput,
  SpawnSkillsInput,
} from "./agents.ts";
export type {
  AccountUsage,
  AgentUsage,
  LimitsNormalizer,
  NormalizedUsage,
  PaneUsage,
  TokenCounts,
  UsageLimitsSource,
  UsageNormalizer,
  UsageTailFormat,
  UsageWindow,
} from "./usage.ts";
export {
  asFiniteNumber,
  asNonEmptyString,
  clampPercent,
  collectTokenCounts,
  isJsonRecord,
} from "./usage.ts";
export type {
  CommandArgSpec,
  CommandArgType,
  CommandArgs,
  CommandError,
  CommandInfo,
  CommandResult,
  PluginCommandSpec,
  PluginCommands,
} from "./commands.ts";
export type { PluginContext } from "./context.ts";
export type { Disposable } from "./disposable.ts";
export {
  downloadPercent,
  type DownloadIntegrity,
  type DownloadPhase,
  type DownloadRequest,
  type DownloadSource,
  type DownloadState,
  type DownloadTarget,
  type PluginDownloads,
} from "./downloads.ts";
export type { PluginEvents } from "./events.ts";
export type { HostSettingsSnapshot, PluginHostFacts } from "./hostFacts.ts";
export type { PluginLogger } from "./log.ts";
export type { PluginNotify, PluginNotifyInput } from "./notifications.ts";
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
  GitBranches,
  GitChangedFile,
  GitCommit,
  GitDiffOptions,
  GitHistory,
  GitHistoryOptions,
  GitStatus,
  GitStatusEntry,
  PluginFs,
  PluginGit,
  PluginOpener,
  PluginPorts,
  PluginServices,
  PluginSessionEvent,
  PluginSessionHandle,
  PluginSessions,
  PluginSpawnOptions,
} from "./services.ts";
export type {
  PluginSpeech,
  SpeechCapture,
  SpeechCaptureOptions,
  SpeechEngine,
  SpeechTranscript,
} from "./speech.ts";
export type {
  CustomSettingsFieldProps,
  PluginSettings,
  SettingsField,
  SettingsSectionContribution,
} from "./settings.ts";
export type {
  PaneSnapshot,
  WorkspaceRef,
  WorkspaceSnapshot,
} from "./snapshots.ts";
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
