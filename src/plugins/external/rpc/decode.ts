import { readManifest } from "@keepdeck/plugin-api";
import type {
  CommandArgSpec,
  CommandInfo,
  CommandResult,
  ForkPlanInput,
  McpServerSpec,
  DownloadIntegrity,
  DownloadRequest,
  DownloadState,
  DownloadTarget,
  DockTabContribution,
  FsCopyOptions,
  FsEntry,
  FsFile,
  FsReadFileOptions,
  GitBlob,
  GitBranches,
  GitChangedFile,
  GitDiff,
  GitDiffOptions,
  GitHistory,
  GitHistoryOptions,
  GitStatus,
  HostSettingsSnapshot,
  PluginExecOutcome,
  PluginExecRequest,
  PluginNotifyInput,
  PluginManifest,
  PluginSpawnOptions,
  ResumePlanInput,
  SettingsSectionContribution,
  SpawnPlanInput,
  SpeechCaptureOptions,
  SpeechDevice,
  SpeechEngine,
  SpeechLevel,
  SpeechTranscript,
  SqlAnswer,
  WorkspaceRef,
} from "@keepdeck/plugin-api";
import type {
  GuestToHostMessage,
  HostToGuestMessage,
  WireAgentHistoryCall,
  WireAgentLiveSessionsCall,
  WireHookCall,
  WireOpenCall,
  WireSessionEvent,
  WireSpawnPlanOutput,
} from "./protocol";

/**
 * Decoders for everything that crosses the external-plugin wire. A value from
 * `postMessage` is `unknown`; each decoder checks the shape it needs and names
 * the refusal, so a malformed message can never be half-read as a contract
 * type. The protocol module names the shapes; this module is the one place
 * that proves them.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export const isString = (value: unknown): value is string => typeof value === "string";
export const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
export const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);
export const isPairs = (value: unknown): value is [string, string][] =>
  Array.isArray(value) &&
  value.every(
    (pair) =>
      Array.isArray(pair) && pair.length === 2 && pair.every(isString),
  );
const isWorkspaceRef = (value: unknown): value is WorkspaceRef =>
  isRecord(value) && isString(value.id) && isString(value.instance);

/** A named refusal, used wherever a wire value does not match its contract. */
export function malformed(what: string, detail?: string): Error {
  return new Error(`malformed ${what}${detail ? `: ${detail}` : ""}`);
}

export function record(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw malformed(what, "expected an object");
  return value;
}

export function str(value: unknown, what: string): string {
  if (!isString(value)) throw malformed(what, "expected a string");
  return value;
}

export function num(value: unknown, what: string): number {
  if (!isNumber(value)) throw malformed(what, "expected a finite number");
  return value;
}

export function bool(value: unknown, what: string): boolean {
  if (!isBoolean(value)) throw malformed(what, "expected a boolean");
  return value;
}

export function optStr(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  return str(value, what);
}

export function strArray(value: unknown, what: string): string[] {
  if (!isStringArray(value)) throw malformed(what, "expected an array of strings");
  return value;
}

export function optional<T>(
  value: unknown,
  guard: (v: unknown) => v is T,
  what: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!guard(value)) throw malformed(what);
  return value;
}

// --------------------------------------------------------------- messages

export function isWireSpawnPlanOutput(value: unknown): value is WireSpawnPlanOutput {
  if (!isRecord(value)) return false;
  if (value.command !== null && !isString(value.command)) return false;
  if (!isStringArray(value.args) || !isPairs(value.env)) return false;
  if (value.envDefaults !== undefined && !isPairs(value.envDefaults)) return false;
  if (value.discard !== undefined) {
    if (!isRecord(value.discard)) return false;
    if (value.discard.onceStarted !== undefined && !isStringArray(value.discard.onceStarted)) return false;
    if (value.discard.ifNeverStarted !== undefined && !isStringArray(value.discard.ifNeverStarted)) return false;
  }
  return true;
}

export function decodeHookCall(value: unknown): WireHookCall {
  const v = record(value, "agent hook call");
  return {
    agentId: str(v.agentId, "agent hook call agentId"),
    hook: str(v.hook, "agent hook call hook"),
    input: v.input,
    output: (() => {
      if (!isWireSpawnPlanOutput(v.output)) throw malformed("agent hook call output");
      return v.output;
    })(),
  };
}

export function decodeAgentHistoryCall(value: unknown): WireAgentHistoryCall {
  const v = record(value, "agent history call");
  const method = str(v.method, "agent history call method");
  if (!Array.isArray(v.args)) throw malformed("agent history call args");
  const agentId = str(v.agentId, "agent history call agentId");
  switch (method) {
    case "list":
    case "listing":
    case "describe":
    case "content":
    case "transcript":
    case "transcriptPage":
      return { agentId, method, args: v.args };
    default:
      throw malformed("agent history call method");
  }
}

export function decodeLiveSessionsCall(value: unknown): WireAgentLiveSessionsCall {
  return { agentId: str(record(value, "agent live-sessions call").agentId, "agent live-sessions call agentId") };
}

export function decodeOpenCall(value: unknown): WireOpenCall {
  const v = record(value, "file-open call");
  const request = record(v.request, "file-open call request");
  return {
    handlerId: str(v.handlerId, "file-open call handlerId"),
    request: { path: str(request.path, "file-open call path") },
  };
}

export function decodeSessionEvent(value: unknown): WireSessionEvent {
  const v = record(value, "session event");
  if (v.type === "output") {
    if (!Array.isArray(v.bytes) || !v.bytes.every((byte) => isNumber(byte) && byte >= 0 && byte <= 255)) {
      throw malformed("session output bytes");
    }
    return { type: "output", bytes: v.bytes };
  }
  if (v.type === "exit") {
    if (v.code !== null && !isNumber(v.code)) throw malformed("session exit code");
    return { type: "exit", code: v.code };
  }
  throw malformed("session event kind");
}

/**
 * The manifest the host activates a guest with, proved by the reader that
 * accepted it on the host — every capability and every contribution, by
 * the same rules — so the realm holds the contract to the host's own
 * standard rather than to a shallower copy of it. The refusal names what
 * the reader refused. The manifest itself goes on exactly as it came.
 */
function assertManifest(value: unknown, what: string): asserts value is PluginManifest {
  const read = readManifest(value);
  if (!read.ok) throw malformed(what, read.errors.join("; "));
}

export function decodeManifest(value: unknown, what: string): PluginManifest {
  assertManifest(value, what);
  return value;
}

export function decodeGuestMessage(value: unknown): GuestToHostMessage {
  const v = record(value, "guest message");
  switch (v.kind) {
    case "ready":
      return { kind: "ready" };
    case "activated":
      return { kind: "activated" };
    case "failed":
      return { kind: "failed", error: str(v.error, "failed message error") };
    case "call":
      if (!isNumber(v.id) || !isString(v.path) || !Array.isArray(v.args)) {
        throw malformed("rpc call");
      }
      return { kind: "call", id: v.id, path: v.path, args: v.args };
    default:
      throw malformed("guest message kind");
  }
}

export function decodeHostMessage(value: unknown): HostToGuestMessage {
  const v = record(value, "host message");
  switch (v.kind) {
    case "init":
      return { kind: "init", manifest: decodeManifest(v.manifest, "init manifest") };
    case "result":
      if (!isNumber(v.id)) throw malformed("rpc result id");
      if (v.ok === true) return { kind: "result", id: v.id, ok: true, value: v.value };
      if (v.ok === false) {
        return {
          kind: "result",
          id: v.id,
          ok: false,
          error: str(v.error, "rpc result error"),
          ...(v.code !== undefined ? { code: str(v.code, "rpc result code") } : {}),
        };
      }
      throw malformed("rpc result ok");
    case "event":
      if (!isString(v.channel)) throw malformed("rpc event channel");
      return { kind: "event", channel: v.channel, payload: v.payload };
    default:
      throw malformed("host message kind");
  }
}

// ----------------------------------------------------------- service args

export function decodeExecRequest(value: unknown): PluginExecRequest {
  const v = record(value, "exec request");
  return {
    key: str(v.key, "exec request key"),
    command: str(v.command, "exec request command"),
    ...(v.args !== undefined ? { args: strArray(v.args, "exec request args") } : {}),
    ...(v.env !== undefined ? { env: pairs(v.env, "exec request env") } : {}),
  };
}

function pairs(value: unknown, what: string): [string, string][] {
  if (!isPairs(value)) throw malformed(what);
  return value;
}

export function decodeSpawnOptions(value: unknown): PluginSpawnOptions {
  const v = record(value, "spawn options");
  let command: string | null | undefined;
  if (v.command === undefined || v.command === null) command = v.command;
  else command = str(v.command, "spawn options command");
  return {
    ...(command !== undefined ? { command } : {}),
    ...(v.args !== undefined ? { args: strArray(v.args, "spawn options args") } : {}),
    ...(v.env !== undefined ? { env: pairs(v.env, "spawn options env") } : {}),
    ...(v.cwd !== undefined ? { cwd: str(v.cwd, "spawn options cwd") } : {}),
    cols: num(v.cols, "spawn options cols"),
    rows: num(v.rows, "spawn options rows"),
  };
}

export function decodeReadFileOptions(value: unknown): FsReadFileOptions | undefined {
  if (value === undefined) return undefined;
  const v = record(value, "read-file options");
  return {
    ...(v.maxBytes !== undefined ? { maxBytes: num(v.maxBytes, "read-file maxBytes") } : {}),
    ...(v.offset !== undefined ? { offset: num(v.offset, "read-file offset") } : {}),
  };
}

export function decodeCopyOptions(value: unknown): FsCopyOptions | undefined {
  if (value === undefined) return undefined;
  const v = record(value, "copy options");
  return v.replace === undefined ? {} : { replace: pairs(v.replace, "copy replace") };
}

export function decodeGitHistoryOptions(value: unknown): GitHistoryOptions | undefined {
  if (value === undefined) return undefined;
  const v = record(value, "git history options");
  return {
    ...(v.base !== undefined ? { base: str(v.base, "git history base") } : {}),
    ...(v.limit !== undefined ? { limit: num(v.limit, "git history limit") } : {}),
    ...(v.rev !== undefined ? { rev: str(v.rev, "git history rev") } : {}),
  };
}

export function decodeGitDiffOptions(value: unknown): GitDiffOptions | undefined {
  if (value === undefined) return undefined;
  const v = record(value, "git diff options");
  return {
    ...(v.staged !== undefined ? { staged: bool(v.staged, "git diff staged") } : {}),
    ...(v.from !== undefined ? { from: str(v.from, "git diff from") } : {}),
    ...(v.to !== undefined ? { to: str(v.to, "git diff to") } : {}),
    ...(v.origPath !== undefined ? { origPath: str(v.origPath, "git diff origPath") } : {}),
  };
}

export function decodeDownloadTarget(value: unknown): DownloadTarget {
  const v = record(value, "download target");
  if (v.kind === "file") return { kind: "file", path: str(v.path, "download target path") };
  if (v.kind === "tarGz") {
    return {
      kind: "tarGz",
      path: str(v.path, "download target path"),
      expectedFiles: strArray(v.expectedFiles, "download target expectedFiles"),
      ...(v.stripSingleRoot !== undefined ? { stripSingleRoot: bool(v.stripSingleRoot, "download stripSingleRoot") } : {}),
    };
  }
  throw malformed("download target kind");
}

export function decodeDownloadIntegrity(value: unknown): DownloadIntegrity {
  const v = record(value, "download integrity");
  if (v.kind === "sha256") {
    return { kind: "sha256", digest: str(v.digest, "integrity digest"), ...(v.bytes !== undefined ? { bytes: num(v.bytes, "integrity bytes") } : {}) };
  }
  if (v.kind === "minisign") {
    return { kind: "minisign", signature: str(v.signature, "integrity signature"), publicKey: str(v.publicKey, "integrity publicKey"), ...(v.bytes !== undefined ? { bytes: num(v.bytes, "integrity bytes") } : {}) };
  }
  if (v.kind === "size") return { kind: "size", bytes: num(v.bytes, "integrity bytes") };
  throw malformed("download integrity kind");
}

export function isDownloadIntegrity(value: unknown): value is DownloadIntegrity {
  try {
    decodeDownloadIntegrity(value);
    return true;
  } catch {
    return false;
  }
}

export function decodeDownloadRequest(value: unknown): DownloadRequest {
  const v = record(value, "download request");
  const source = record(v.source, "download source");
  const headers = source.headers === undefined ? undefined : Object.fromEntries(
    Object.entries(record(source.headers, "download headers")).map(([key, header]) => [key, str(header, "download header")]),
  );
  return {
    id: str(v.id, "download request id"),
    source: { url: str(source.url, "download source url"), ...(headers ? { headers } : {}) },
    target: decodeDownloadTarget(v.target),
    ...(v.integrity !== undefined ? { integrity: decodeDownloadIntegrity(v.integrity) } : {}),
  };
}

export function decodeSpeechOptions(value: unknown): SpeechCaptureOptions {
  const v = record(value, "speech options");
  const engine = str(v.engine, "speech engine");
  if (engine !== "whisper" && engine !== "parakeet") throw malformed("speech engine");
  return {
    engine,
    modelPath: str(v.modelPath, "speech modelPath"),
    ...(v.language !== undefined ? { language: str(v.language, "speech language") } : {}),
    ...(v.prompt !== undefined ? { prompt: str(v.prompt, "speech prompt") } : {}),
  };
}

export function isCommandArgs(value: unknown): value is Record<string, string | boolean | number> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((cell) => isString(cell) || isBoolean(cell) || isNumber(cell));
}

export function isSessionSpawn(value: unknown): value is { id: string } {
  return isRecord(value) && isString(value.id);
}

export function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

export function isDeckChannel(value: unknown): value is "workspaceClosed" | "paneSelected" | "deckChanged" {
  return value === "workspaceClosed" || value === "paneSelected" || value === "deckChanged";
}

export function decodeWith<T>(
  value: unknown,
  guard: (v: unknown) => v is T,
  what: string,
): T {
  if (!guard(value)) throw malformed(what);
  return value;
}

// ------------------------------------------------- registration payloads

export function isSettingsSection(value: unknown): value is SettingsSectionContribution {
  if (!isRecord(value) || !isString(value.label) || !Array.isArray(value.fields)) return false;
  if (value.stored !== undefined && !isStringArray(value.stored)) return false;
  return value.fields.every((field) => {
    if (!isRecord(field) || !isString(field.kind) || !isString(field.key) || !isString(field.label)) return false;
    return field.kind !== "custom";
  });
}

export function isDockTab(value: unknown): value is DockTabContribution {
  return isRecord(value) && isString(value.id) && isString(value.label) && isString(value.iframe);
}

export function isNotifyInput(value: unknown): value is PluginNotifyInput {
  if (!isRecord(value) || !isString(value.title)) return false;
  if (value.body !== undefined && !isString(value.body)) return false;
  if (value.severity !== undefined && value.severity !== "info" && value.severity !== "warning" && value.severity !== "error") return false;
  if (value.workspace !== undefined && !isWorkspaceRef(value.workspace)) return false;
  if (value.dockTab !== undefined && !isString(value.dockTab)) return false;
  if (value.tag !== undefined && !isString(value.tag)) return false;
  return true;
}

export interface WireActionEntry { id: string; title: string }
export const isActionEntry = (value: unknown): value is WireActionEntry =>
  isRecord(value) && isString(value.id) && isString(value.title);

export interface WireOverlayEntry { id: string; iframe: string }
export const isOverlayEntry = (value: unknown): value is WireOverlayEntry =>
  isRecord(value) && isString(value.id) && isString(value.iframe);

export interface WireOpenerEntry { id: string; label: string }
export const isOpenerEntry = (value: unknown): value is WireOpenerEntry =>
  isRecord(value) && isString(value.id) && isString(value.label);

export interface WireAgentRegistration {
  id: string;
  label: string;
  icon: unknown;
  detect: { bin: string };
  hookNames?: string[];
  hasHistory?: boolean;
  hasListing?: boolean;
  hasTranscriptPage?: boolean;
  hasLiveSessions?: boolean;
  usage?: unknown;
}

export function isAgentRegistration(value: unknown): value is WireAgentRegistration {
  if (!isRecord(value) || !isString(value.id) || !isString(value.label)) return false;
  if (!isRecord(value.detect) || !isString(value.detect.bin)) return false;
  for (const name of ["hookNames"] as const) {
    if (value[name] !== undefined && !isStringArray(value[name])) return false;
  }
  for (const name of ["hasHistory", "hasListing", "hasTranscriptPage", "hasLiveSessions"] as const) {
    if (value[name] !== undefined && !isBoolean(value[name])) return false;
  }
  return true;
}

// ------------------------------------------------------------ inputs/results

/** One injected MCP server, by its transport. */
function assertMcpServer(value: unknown, what: string): asserts value is McpServerSpec {
  const v = record(value, what);
  str(v.name, `${what}.name`);
  if (v.transport === "stdio") {
    str(v.command, `${what}.command`);
    strArray(v.args, `${what}.args`);
    if (v.envPassthrough !== undefined) strArray(v.envPassthrough, `${what}.envPassthrough`);
    return;
  }
  if (v.transport === "http") {
    str(v.url, `${what}.url`);
    if (v.headers !== undefined) {
      const headers = record(v.headers, `${what}.headers`);
      for (const [name, header] of Object.entries(headers)) str(header, `${what}.headers.${name}`);
    }
    optStr(v.bearerTokenEnv, `${what}.bearerTokenEnv`);
    return;
  }
  throw malformed(`${what}.transport`, `expected "stdio" or "http"`);
}

/**
 * A spawn plan's input, every field the contract names — the staged skills
 * directories, each injected MCP server, the remote target — checked, each
 * refusal naming its path. The input goes on exactly as the host built it.
 */
function assertSpawnPlanInput(value: unknown, what: string): asserts value is SpawnPlanInput {
  const v = record(value, what);
  str(v.paneId, `${what}.paneId`);
  str(v.cwd, `${what}.cwd`);
  if (!isWorkspaceRef(v.workspace)) throw malformed(`${what}.workspace`, "expected a workspace ref");
  optStr(v.branch, `${what}.branch`);
  optStr(v.cliVersion, `${what}.cliVersion`);
  if (v.yolo !== undefined) bool(v.yolo, `${what}.yolo`);
  if (v.skills !== undefined) {
    const skills = record(v.skills, `${what}.skills`);
    for (const dir of ["claudePluginDir", "opencodeConfigDir", "skillsDir"] as const) {
      str(skills[dir], `${what}.skills.${dir}`);
    }
  }
  if (v.mcp !== undefined) {
    const mcp = record(v.mcp, `${what}.mcp`);
    if (!Array.isArray(mcp.servers)) throw malformed(`${what}.mcp.servers`, "expected an array");
    for (const [index, server] of mcp.servers.entries()) assertMcpServer(server, `${what}.mcp.servers[${index}]`);
  }
  if (v.target !== undefined) {
    const target = record(v.target, `${what}.target`);
    if (target.kind !== "nativeServer") throw malformed(`${what}.target.kind`, `expected "nativeServer"`);
    str(target.endpoint, `${what}.target.endpoint`);
  }
}

function assertResumePlanInput(value: unknown, what: string): asserts value is ResumePlanInput {
  assertSpawnPlanInput(value, what);
  str(record(value, what).sessionId, `${what}.sessionId`);
}

function assertForkPlanInput(value: unknown, what: string): asserts value is ForkPlanInput {
  assertResumePlanInput(value, what);
  const v = record(value, what);
  str(v.sourceCwd, `${what}.sourceCwd`);
  optStr(v.transcriptPath, `${what}.transcriptPath`);
}

export function decodeSpawnPlanInput(value: unknown, what: string): SpawnPlanInput {
  assertSpawnPlanInput(value, what);
  return value;
}

export function decodeResumePlanInput(value: unknown, what: string): ResumePlanInput {
  assertResumePlanInput(value, what);
  return value;
}

export function decodeForkPlanInput(value: unknown, what: string): ForkPlanInput {
  assertForkPlanInput(value, what);
  return value;
}

export interface WirePage { offset: number; limit: number }
export const isPage = (value: unknown): value is WirePage =>
  isRecord(value) && isNumber(value.offset) && isNumber(value.limit);

export function isFsEntry(value: unknown): value is FsEntry {
  if (!isRecord(value) || !isString(value.name) || !isString(value.path)) return false;
  if (value.kind !== "file" && value.kind !== "dir" && value.kind !== "symlink") return false;
  if (value.size !== undefined && !isNumber(value.size)) return false;
  if (value.mtime !== undefined && !isNumber(value.mtime)) return false;
  return true;
}
export const isFsEntries = (value: unknown): value is FsEntry[] =>
  Array.isArray(value) && value.every(isFsEntry);

export function isFsFile(value: unknown): value is FsFile {
  return isRecord(value) && isString(value.path) &&
    (value.text === null || isString(value.text)) &&
    isBoolean(value.isBinary) && isNumber(value.size) &&
    isBoolean(value.truncated) && isNumber(value.readBytes);
}

export function isSqlAnswer(value: unknown): value is SqlAnswer {
  if (!isRecord(value) || !Array.isArray(value.rows)) return false;
  if (value.stopped !== "exhausted" && value.stopped !== "budget") return false;
  if (!isNumber(value.payloadBytes)) return false;
  return value.rows.every((row) => Array.isArray(row) && row.every((cell) => cell === null || isString(cell)));
}

export function isGitDiff(value: unknown): value is GitDiff {
  return isRecord(value) && isString(value.text) && isBoolean(value.truncated);
}

/** A stored file, or the null that says it is not there. */
export function isGitBlobAnswer(value: unknown): value is GitBlob | null {
  return value === null || (isRecord(value) &&
    (value.text === null || isString(value.text)) &&
    isBoolean(value.isBinary) && isBoolean(value.truncated));
}

export function isGitStatus(value: unknown): value is GitStatus {
  if (!isRecord(value) || !Array.isArray(value.entries)) return false;
  if (value.branch !== null && !isString(value.branch)) return false;
  if (!isBoolean(value.detached)) return false;
  if (value.oid !== null && !isString(value.oid)) return false;
  if (value.upstream !== null && !isString(value.upstream)) return false;
  if (value.ahead !== null && !isNumber(value.ahead)) return false;
  if (value.behind !== null && !isNumber(value.behind)) return false;
  return value.entries.every((entry) => isRecord(entry) && isString(entry.path) &&
    (entry.origPath === null || isString(entry.origPath)) && isString(entry.staged) &&
    isString(entry.unstaged) && isBoolean(entry.untracked) && isBoolean(entry.conflicted));
}

export function isGitBranches(value: unknown): value is GitBranches {
  return isRecord(value) && (value.current === null || isString(value.current)) && isStringArray(value.branches);
}

export function isGitHistory(value: unknown): value is GitHistory {
  if (!isRecord(value) || !Array.isArray(value.commits)) return false;
  if (value.forkSha !== null && !isString(value.forkSha)) return false;
  if (value.ahead !== null && !isNumber(value.ahead)) return false;
  return value.commits.every((commit) => isRecord(commit) && isString(commit.sha) &&
    isString(commit.author) && isNumber(commit.timestamp) && isString(commit.subject));
}

export function isGitChangedFiles(value: unknown): value is GitChangedFile[] {
  return Array.isArray(value) && value.every((entry) => isRecord(entry) && isString(entry.path) &&
    (entry.origPath === null || isString(entry.origPath)) && isString(entry.code));
}

export function isExecOutcome(value: unknown): value is PluginExecOutcome {
  return isRecord(value) && isBoolean(value.ran) && isBoolean(value.ok) && isString(value.said);
}

export function isSpeechEngines(value: unknown): value is SpeechEngine[] {
  return Array.isArray(value) && value.every((engine) => engine === "whisper" || engine === "parakeet");
}

export function isSpeechDevices(value: unknown): value is SpeechDevice[] {
  return Array.isArray(value) && value.every((device) => isRecord(device) && isString(device.id) &&
    isString(device.name) && isBoolean(device.isDefault));
}

export function isSpeechStart(value: unknown): value is { device: string; deviceMissing: boolean } {
  return isRecord(value) && isString(value.device) && isBoolean(value.deviceMissing);
}

export function isSpeechTranscript(value: unknown): value is SpeechTranscript {
  return isRecord(value) && isString(value.text) && isBoolean(value.silence) &&
    (value.silenceReason === null || value.silenceReason === "no-audio" || value.silenceReason === "dead-signal" || value.silenceReason === "no-speech") &&
    isNumber(value.seconds) && isNumber(value.level) && isNumber(value.peak) &&
    isNumber(value.clippedRatio) && isNumber(value.dcOffset) && isString(value.device) && isBoolean(value.cutShort);
}

export function isCommandResult(value: unknown): value is CommandResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) return true;
  if (value.ok !== false || !isRecord(value.error)) return false;
  return (value.error.code === "unknown-command" || value.error.code === "invalid-args" ||
    value.error.code === "not-permitted" || value.error.code === "failed") && isString(value.error.message);
}

const COMMAND_ARG_TYPES: readonly CommandArgSpec["type"][] = ["string", "boolean", "number"];

/** One declared argument: a name, a primitive type, whether it is required,
 * and its description. */
function assertCommandArg(value: unknown, what: string): asserts value is CommandArgSpec {
  const v = record(value, what);
  str(v.name, `${what}.name`);
  if (!COMMAND_ARG_TYPES.some((type) => type === v.type)) {
    throw malformed(`${what}.type`, `expected one of ${COMMAND_ARG_TYPES.join(", ")}`);
  }
  if (v.required !== undefined) bool(v.required, `${what}.required`);
  str(v.description, `${what}.description`);
}

function assertCommandInfos(value: unknown, what: string): asserts value is CommandInfo[] {
  if (!Array.isArray(value)) throw malformed(what, "expected an array");
  for (const [index, entry] of value.entries()) {
    const info = record(entry, `${what}[${index}]`);
    str(info.id, `${what}[${index}].id`);
    str(info.title, `${what}[${index}].title`);
    if (!Array.isArray(info.args)) throw malformed(`${what}[${index}].args`, "expected an array");
    for (const [at, arg] of info.args.entries()) assertCommandArg(arg, `${what}[${index}].args[${at}]`);
  }
}

/** The command list, each command's every declared argument checked. */
export function decodeCommandInfos(value: unknown, what: string): CommandInfo[] {
  assertCommandInfos(value, what);
  return value;
}

export function isHostSettings(value: unknown): value is HostSettingsSnapshot {
  return isRecord(value) && isNumber(value.terminalScrollback);
}

export function isDownloadState(value: unknown): value is DownloadState {
  if (!isRecord(value) || !isString(value.id) || !isNumber(value.received)) return false;
  if (!["queued", "downloading", "verifying", "unpacking", "completed", "cancelled", "failed"].includes(String(value.phase))) return false;
  if (value.total !== null && !isNumber(value.total)) return false;
  if (value.error !== undefined && !isString(value.error)) return false;
  return true;
}

export function isSpeechLevel(value: unknown): value is SpeechLevel {
  return isRecord(value) && isNumber(value.rms) && isNumber(value.peak) &&
    isBoolean(value.clipped) && isNumber(value.dcOffset);
}

export function isWorkspaceEvent(value: unknown): value is { workspace: WorkspaceRef } {
  return isRecord(value) && isWorkspaceRef(value.workspace);
}

export function isPaneEvent(value: unknown): value is { workspace: WorkspaceRef; paneId: string | null } {
  return isRecord(value) && isWorkspaceRef(value.workspace) &&
    (value.paneId === null || isString(value.paneId));
}
