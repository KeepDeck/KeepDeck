/** The runtime half of a plugin: the context handed to `activate` and the
 * role interfaces it aggregates — one module per concern. */
export type {
  AgentContribution,
  AgentHooks,
  AgentIcon,
  AgentHistory,
  AgentIconPath,
  AgentLiveSession,
  AgentLiveSessions,
  AgentSessionFacts,
  AgentSessionStub,
  AgentTranscriptEntry,
  AgentBinding,
  AgentBindingReport,
  AgentCompanion,
  AgentPresentation,
  CompanionCover,
  ForkDiscard,
  ForkPlanInput,
  PluginAgents,
  ResumePlanInput,
  Shortfall,
  SpawnPlanInput,
  SpawnPlanOutput,
  McpHttpServerSpec,
  McpServerSpec,
  McpStdioServerSpec,
  SpawnMcpInput,
  SpawnSkillsInput,
  SpawnTarget,
} from "./agents.ts";
export { isAgentPresentation, MCP_HTTP_API, mapMcpServers, mcpHttpHeaders } from "./agents.ts";
export type {
  AgentStatus,
  AgentStatusEvent,
  DeliverableMail,
  MailReplyInput,
  MailReplyRenderer,
  StatusNormalizer,
  StatusNormalization,
  StatusPayload,
  StatusReduction,
  StatusWaitReason,
} from "./status.ts";
export {
  admitMail,
  admittedNormalizer,
  agentIdActor,
  collectsAtTurnEnd,
  mailAskArgs,
  type AgentMail,
  type EventActor,
  type EventAttribution,
  type MailAdmission,
  type MailChannel,
} from "./agentEvents.ts";
export {
  decodeStatusPayload,
  frameTeammateMail,
  turnFailedEvent,
} from "./status.ts";
export {
  updateQuestionCalls,
  reduceQuestionStatus,
  isQuestionState,
  questionStateOf,
  type QuestionCalls,
  type QuestionState,
} from "./questionCalls.ts";
export type {
  AccountUsage,
  AgentUsage,
  ApiActivity,
  AgentLimits,
  LimitsNormalizer,
  LimitsRead,
  NormalizedUsage,
  PaneUsage,
  TokenCounts,
  UsageNormalizer,
  UsageTail,
  UsageWindow,
} from "./usage.ts";
export {
  allowanceWindow,
  asCount,
  asFiniteNumber,
  asNonEmptyString,
  carriedUsageRecord,
  clampPercent,
  collectTokenCounts,
  parseJsonRecord,
  percentWindow,
  reportedLimits,
  tailWatches,
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
export { errorMessage, parseInstant, sha256Hex, shellQuote } from "./authoring.ts";
export { launchPlans, type ForkLaunch, type LaunchAdapter, type ResumeLaunch } from "./launchPlans.ts";
export {
  fileStub,
  pageOfWalk,
  readStoreDir,
  sessionHistory,
  type SessionStore,
  type TranscriptPage,
} from "./sessionHistory.ts";
export { isJsonRecord, isJsonValue, keyList, type JsonValue } from "../json.ts";
export {
  firstMeaningfulUserTurn,
  textFromParts,
  titleText,
  transcriptRole,
  trimmedText,
} from "./historyText.ts";
export type { PluginContext } from "./context.ts";
export type { Disposable, WatchHandle } from "./disposable.ts";
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
  GitBlob,
  GitBranches,
  GitChangedFile,
  GitCommit,
  GitDiff,
  GitDiffOptions,
  GitHistory,
  GitHistoryOptions,
  GitStatus,
  GitStatusEntry,
  PluginFs,
  PluginFsWrite,
  FsCopyOptions,
  PluginSqlite,
  SqlAnswer,
  PluginGit,
  PluginOpener,
  PluginPorts,
  PluginServices,
  PluginClipboard,
  PluginSessionEvent,
  PluginSessionHandle,
  PluginExec,
  PluginExecOutcome,
  PluginExecRequest,
  PluginRpc,
  RpcAnswer,
  RpcCall,
  PluginHttp,
  HttpGet,
  HttpAnswer,
  PluginEnv,
  PluginSessions,
  PluginSpawnOptions,
} from "./services.ts";
export {
  createSessionStore,
  jsonl,
  type JsonlRequest,
  type PluginSessionStore,
  type ReadBudget,
  type ReadOutcome,
  type ReadScope,
  type ReadStop,
  type SessionCursor,
  type SessionFormat,
  type SessionReader,
} from "./sessionRead.ts";
export {
  CARRIED_RECORD,
  tailPass,
  watchMatches,
  watchProject,
  type RecordMatch,
  type SessionTailDialect,
  type TailLane,
  type TailPass,
  type TailSum,
  type TailTarget,
  type TailWatch,
} from "./sessionTail.ts";
export {
  CONTENT_CAP,
  walkSession,
  type SessionDialect,
  type WalkedSession,
} from "./sessionWalk.ts";
export type {
  PluginSpeech,
  SpeechCapture,
  SpeechCaptureOptions,
  SpeechDevice,
  SpeechEngine,
  SpeechErrorKind,
  SpeechLevel,
  SpeechSilenceReason,
  SpeechStartOptions,
  SpeechTranscript,
} from "./speech.ts";
export { SPEECH_ERROR_KINDS, speechErrorKind } from "./speech.ts";
export type {
  CustomSettingsFieldProps,
  PluginSettings,
  SettingsField,
  SettingsSectionContribution,
} from "./settings.ts";
export { declaredKeys, mergeSectionValues } from "./settings.ts";
export type {
  PaneSnapshot,
  TeamSnapshot,
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
