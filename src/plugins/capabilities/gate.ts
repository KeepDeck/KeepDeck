import type {
  Capability,
  DownloadRequest,
  DownloadTarget,
  WatchHandle,
  GitDiff,
  FsEntry,
  FsFile,
  FsCopyOptions,
  FsReadFileOptions,
  GitBlob,
  GitBranches,
  GitChangedFile,
  GitDiffOptions,
  GitHistory,
  GitHistoryOptions,
  GitStatus,
  HttpAnswer,
  HttpGet,
  JsonValue,
  PluginLogger,
  PluginFs,
  PluginManifest,
  PluginOpener,
  PluginPorts,
  PluginServices,
  PluginSessions,
  PluginSpeech,
  RpcAnswer,
  RpcServerDeclaration,
  SqlAnswer,
} from "@keepdeck/plugin-api";
import { createSessionStore } from "@keepdeck/plugin-api";
import { isObjectLike } from "../../domain/json";
import { execCovers } from "./execCovers";
import type { ResolvedPermissions } from "./permissions";

/** The two scopes the `fs` capability may declare, as the backend consumes
 * them: the gate DERIVES this from the manifest and passes it down; the backend
 * resolves it to concrete roots (the deck's folders, or none). */
export type FsScope = "workspace" | "everywhere";

/** The scope-aware fs backend the gate wraps. Wider than the public `PluginFs`
 * a plugin sees: it carries the scope the gate derived from the manifest, so
 * the host can turn scope into the roots it enforces containment against. The
 * plugin never supplies the scope — the manifest is the only source. */
export interface FsBackend {
  readDir(path: string, scope: FsScope): Promise<FsEntry[]>;
  readFile(
    path: string,
    scope: FsScope,
    opts?: FsReadFileOptions,
  ): Promise<FsFile>;
  watch(path: string, scope: FsScope, onChange: () => void): WatchHandle;
}

/** The write backend the gate wraps: every call names the plugin it is
 * made for, and the native side holds it — both ends of a copy or a move —
 * to that plugin's own roots: its declared `fsWrite` prefixes and the
 * workspace directories it was handed, looked up by its id. Neither the
 * plugin nor the gate supplies a root. */
export interface FsWriteBackend {
  mkdir(pluginId: string, path: string): Promise<void>;
  copyFile(pluginId: string, src: string, dst: string, options?: FsCopyOptions): Promise<void>;
  remove(pluginId: string, path: string): Promise<void>;
  writeFile(pluginId: string, path: string, text: string): Promise<void>;
  appendLine(pluginId: string, path: string, line: string): Promise<void>;
  move(pluginId: string, src: string, dst: string): Promise<void>;
}

/** The read-only SQL backend, mirroring [`FsWriteBackend`]: held natively to
 * the plugin's declared `sqliteReadonly` prefixes. */
export interface SqliteBackend {
  query(pluginId: string, dbPath: string, sql: string, params: string[]): Promise<SqlAnswer>;
}

/** The scope-aware git backend, mirroring [`FsBackend`]: the gate derives the
 * scope from the manifest's `git` capability, the backend resolves it to the
 * same roots fs containment uses. */
export interface GitBackend {
  status(repo: string, scope: FsScope): Promise<GitStatus>;
  diffFile(
    repo: string,
    file: string,
    scope: FsScope,
    opts?: GitDiffOptions,
  ): Promise<GitDiff>;
  fileAt(
    repo: string,
    file: string,
    rev: string | undefined,
    scope: FsScope,
  ): Promise<GitBlob | null>;
  history(
    repo: string,
    scope: FsScope,
    opts?: GitHistoryOptions,
  ): Promise<GitHistory>;
  branches(repo: string, scope: FsScope): Promise<GitBranches>;
  changedFiles(
    repo: string,
    from: string,
    to: string | undefined,
    scope: FsScope,
  ): Promise<GitChangedFile[]>;
  watch(repo: string, scope: FsScope, onChange: () => void): WatchHandle;
}

/** The ungated platform backends the gate decorates. Identical to
 * `PluginServices` except `fs`/`git`: those backends are scope-aware (the gate
 * injects the scope), while the services the gate RETURNS match the public,
 * scope-free contracts the plugin calls. */
export interface ServiceBackends {
  sessions: PluginSessions;
  /** The host's bounded, terminal-less run. Admitted by the SAME rule as
   * `sessions.spawn` — a plugin that may run a command in a pane may run it
   * without one; nothing here widens what may be run. */
  exec: import("@keepdeck/plugin-api").PluginExec;
  /** The host's JSON-RPC children. The gate hands over the MANIFEST's
   * declaration of the server, never the plugin's words; the native side
   * holds the call to that shape. `stop` ends every child of the plugin. */
  rpc: {
    request(
      pluginId: string,
      server: RpcServerDeclaration,
      method: string,
      params: JsonValue | undefined,
    ): Promise<RpcAnswer>;
    stop(pluginId: string): Promise<void>;
  };
  ports: PluginPorts;
  /** One bounded GET on `pluginId`'s behalf. The native side looks up the
   * reach and the credential source in that plugin's resolved grant, admits
   * the URL and reads the token itself — nothing of the grant is passed. */
  http: {
    get(pluginId: string, request: HttpGet): Promise<HttpAnswer>;
  };
  opener: PluginOpener;
  fs: FsBackend;
  fsWrite: FsWriteBackend;
  sqlite: SqliteBackend;
  git: GitBackend;
  /** `start` names the plugin a transfer runs for; the native side holds
   * its URL and every redirect to that plugin's `net` reach. */
  downloads: {
    start(
      pluginId: string,
      request: DownloadRequest,
      onTerminal: () => void,
    ): AsyncIterable<import("@keepdeck/plugin-api").DownloadState>;
    cancel(id: string): Promise<void>;
    exists(
      pluginId: string,
      target: DownloadTarget,
      integrity?: DownloadRequest["integrity"],
    ): Promise<boolean>;
    remove(pluginId: string, target: DownloadTarget): Promise<void>;
  };
  speech: {
    engines: PluginSpeech["engines"];
    devices: PluginSpeech["devices"];
    startCapture(
      pluginId: string,
      onLevel?: Parameters<PluginSpeech["startCapture"]>[0],
      options?: Parameters<PluginSpeech["startCapture"]>[1],
    ): ReturnType<PluginSpeech["startCapture"]>;
  };
  /** Text clipboard backend. No scope of its own — the gate admits each
   * direction by its OWN capability (write vs read), so the backend is just
   * the host's single native clipboard path, unparametrized. */
  clipboard: {
    writeText(text: string): Promise<void>;
    readText(): Promise<string>;
  };
}

/**
 * CapabilityGate v0 — decorates an ungated `PluginServices` backend so every
 * call is checked against the manifest's declared capabilities before it
 * reaches the backend. This is the "granter at the call site" half of the
 * Zed model described on `Capability` (plugin-api): the manifest declares,
 * install-time consent approves the declaration, and this gate is what
 * actually stops an undeclared call at runtime — without it, capabilities
 * would be a label nobody enforces.
 *
 * Trusted built-ins additionally log violations, but diagnostics never
 * weaken authorization semantics: every violation is denied.
 *
 * Most services are pure decoration and forward allowed calls verbatim. The
 * download surface additionally retains a bounded set of ids so one plugin
 * cannot cancel another plugin's globally keyed job.
 *
 * `fs` IS gated here now (a file-reading plugin gave it a service to guard):
 * the gate admits the call only if the manifest declares an `fs` capability and
 * passes the DECLARED SCOPE to the backend, which resolves scope into the roots
 * it enforces containment against — the plugin never supplies the scope.
 * `http`, `downloads`, `fsWrite` and `sqlite` only name the plugin: what it
 * may reach, write or read is decided natively against its grant.
 */
export type GateDiagnostics = "log" | "silent";

export function createCapabilityGate(
  manifest: PluginManifest,
  backend: ServiceBackends,
  opts: {
    diagnostics: GateDiagnostics;
    log: PluginLogger;
    /** What this manifest's `env` resolved to — the only source of env
     * values the gate hands out. */
    permissions: ResolvedPermissions;
  },
): PluginServices {
  const { diagnostics, log, permissions } = opts;
  const declaredEnv = new Set(
    manifest.capabilities.flatMap((capability) => (capability.kind === "env" ? capability.names : [])),
  );
  const maxActiveDownloads = 8;
  const activeDownloadIds = new Set<string>();

  /** One authorization path. Diagnostics add visibility, never authority. */
  function admit(ok: boolean, message: string): asserts ok {
    if (ok) return;
    if (diagnostics === "log") log.warn(message);
    throw new Error(message);
  }

  function finishDownload(id: string): void {
    activeDownloadIds.delete(id);
  }

  /** Named rather than inlined below because the session-store reader is
   * built ON it: a store the plugin may walk is exactly a file it may read,
   * and routing the reader through this object is what makes that true by
   * construction instead of by a second check kept in step by hand. */
  const fs: PluginFs = {
    readDir(path) {
      admit(
        hasFsCapability(manifest.capabilities),
        `fs.readDir: "${path}" requires an "fs" capability, which the manifest does not declare`,
      );
      return backend.fs.readDir(path, fsScope(manifest.capabilities));
    },
    readFile(path, opts) {
      admit(
        hasFsCapability(manifest.capabilities),
        `fs.readFile: "${path}" requires an "fs" capability, which the manifest does not declare`,
      );
      return backend.fs.readFile(path, fsScope(manifest.capabilities), opts);
    },
    watch(path, onChange) {
      admit(
        hasFsCapability(manifest.capabilities),
        `fs.watch: "${path}" requires an "fs" capability, which the manifest does not declare`,
      );
      return backend.fs.watch(path, fsScope(manifest.capabilities), onChange);
    },
  };

  return {
    sessions: {
      spawn(spawnOpts, onEvent) {
        // No command means the user's shell; a manifest that wants to spawn
        // it declares the literal entry "$SHELL" (see `PluginSpawnOptions`).
        const subject = spawnOpts.command ?? "$SHELL";
        admit(
          execCovers(manifest.capabilities, subject),
          `sessions.spawn: "${subject}" requires an "exec" capability covering it, which the manifest does not declare`,
        );
        return backend.sessions.spawn(spawnOpts, onEvent);
      },
    },
    exec: {
      runOnce(request) {
        admit(
          execCovers(manifest.capabilities, request.command),
          `exec.runOnce: "${request.command}" requires an "exec" capability covering it, which the manifest does not declare`,
        );
        // The single-flight key is namespaced by the plugin that asked.
        // Keys are caller-chosen strings, so two plugins could otherwise
        // collide — and a collision hands one plugin the other's run
        // result, including the tail of its failing output. Plugins share
        // the host's runner; they do not share each other's runs.
        return backend.exec.runOnce({
          ...request,
          key: `${manifest.id}:${request.key}`,
        });
      },
    },
    rpc: {
      request(call) {
        const server = rpcServer(manifest.capabilities, call.server);
        admit(
          server !== undefined,
          `rpc.request: server "${call.server}" is not declared in an "exec" capability`,
        );
        admit(
          execCovers(manifest.capabilities, server.command),
          `rpc.request: "${server.command}" is not among the "exec" commands`,
        );
        admit(
          server.methods.includes(call.method),
          `rpc.request: "${call.method}" is not a declared method of "${call.server}"`,
        );
        return backend.rpc.request(
          manifest.id,
          withClientVersion(server, manifest.version),
          call.method,
          call.params,
        );
      },
    },
    ports: {
      allocate(key) {
        admit(
          hasPortsCapability(manifest.capabilities),
          `ports.allocate: "${key}" requires a "ports" capability, which the manifest does not declare`,
        );
        return backend.ports.allocate(key);
      },
    },
    opener: {
      openUrl(url) {
        admit(
          hasOpenCapability(manifest.capabilities),
          `opener.openUrl: "${url}" requires an "open" capability, which the manifest does not declare`,
        );
        return backend.opener.openUrl(url);
      },
      openPath(path) {
        admit(
          hasOpenCapability(manifest.capabilities),
          `opener.openPath: "${path}" requires an "open" capability, which the manifest does not declare`,
        );
        return backend.opener.openPath(path);
      },
      openPathWith(path, application) {
        admit(
          hasOpenCapability(manifest.capabilities),
          `opener.openPathWith: "${path}" requires an "open" capability, which the manifest does not declare`,
        );
        return backend.opener.openPathWith(path, application);
      },
    },
    fs,
    sessionStore: createSessionStore(fs),
    fsWrite: {
      mkdir: (path) => backend.fsWrite.mkdir(manifest.id, path),
      copyFile: (src, dst, options) => backend.fsWrite.copyFile(manifest.id, src, dst, options),
      remove: (path) => backend.fsWrite.remove(manifest.id, path),
      writeFile: (path, text) => backend.fsWrite.writeFile(manifest.id, path, text),
      appendLine: (path, line) => backend.fsWrite.appendLine(manifest.id, path, line),
      move: (src, dst) => backend.fsWrite.move(manifest.id, src, dst),
    },
    sqlite: {
      query: (dbPath, sql, params) => backend.sqlite.query(manifest.id, dbPath, sql, params ?? []),
    },
    git: {
      status(repo) {
        admit(
          hasGitCapability(manifest.capabilities),
          `git.status: "${repo}" requires a "git" capability, which the manifest does not declare`,
        );
        return backend.git.status(repo, gitScope(manifest.capabilities));
      },
      diffFile(repo, file, opts) {
        admit(
          hasGitCapability(manifest.capabilities),
          `git.diffFile: "${repo}" requires a "git" capability, which the manifest does not declare`,
        );
        // Always the GitDiff: the bare text an external plugin from before
        // the cap flag expects is handed out by its RPC bridge
        // (hostServices), the one place an older contract can be spoken.
        return backend.git.diffFile(
          repo,
          file,
          gitScope(manifest.capabilities),
          opts,
        );
      },
      fileAt(repo, file, rev) {
        admit(
          hasGitCapability(manifest.capabilities),
          `git.fileAt: "${repo}" requires a "git" capability, which the manifest does not declare`,
        );
        return backend.git.fileAt(repo, file, rev, gitScope(manifest.capabilities));
      },
      history(repo, opts) {
        admit(
          hasGitCapability(manifest.capabilities),
          `git.history: "${repo}" requires a "git" capability, which the manifest does not declare`,
        );
        return backend.git.history(repo, gitScope(manifest.capabilities), opts);
      },
      branches(repo) {
        admit(
          hasGitCapability(manifest.capabilities),
          `git.branches: "${repo}" requires a "git" capability, which the manifest does not declare`,
        );
        return backend.git.branches(repo, gitScope(manifest.capabilities));
      },
      changedFiles(repo, from, to) {
        admit(
          hasGitCapability(manifest.capabilities),
          `git.changedFiles: "${repo}" requires a "git" capability, which the manifest does not declare`,
        );
        return backend.git.changedFiles(
          repo,
          from,
          to,
          gitScope(manifest.capabilities),
        );
      },
      watch(repo, onChange) {
        admit(
          hasGitCapability(manifest.capabilities),
          `git.watch: "${repo}" requires a "git" capability, which the manifest does not declare`,
        );
        return backend.git.watch(
          repo,
          gitScope(manifest.capabilities),
          onChange,
        );
      },
    },
    env: {
      get(name) {
        // An undeclared name is not refused, it is absent: asking reveals
        // nothing about whether the variable exists.
        return Promise.resolve(declaredEnv.has(name) ? (permissions.env[name] ?? null) : null);
      },
    },
    http: {
      get(request) {
        // Which reach applies, and whether the URL fits it, is decided
        // natively against this plugin's grant — the gate only names it.
        return backend.http.get(manifest.id, request);
      },
    },
    downloads: {
      start(request) {
        if (activeDownloadIds.size >= maxActiveDownloads) {
          throw new Error(
            `plugin has too many active downloads (limit ${maxActiveDownloads})`,
          );
        }
        if (activeDownloadIds.has(request.id)) {
          throw new Error(
            `download id already used by this plugin: ${request.id}`,
          );
        }
        // The backend can reject synchronously (for example a global id or
        // target collision). Ownership is granted only after it accepted.
        let terminal = false;
        const stream = backend.downloads.start(manifest.id, request, () => {
          terminal = true;
          finishDownload(request.id);
        });
        if (!terminal) activeDownloadIds.add(request.id);
        return stream;
      },
      cancel(id) {
        admit(
          activeDownloadIds.has(id),
          `downloads.cancel: "${id}" was not started by this plugin`,
        );
        return backend.downloads.cancel(id).then(() => finishDownload(id));
      },
      exists(target, integrity) {
        return backend.downloads.exists(manifest.id, target, integrity);
      },
      remove(target) {
        return backend.downloads.remove(manifest.id, target);
      },
    },
    speech: {
      engines() {
        admit(
          hasMicCapability(manifest.capabilities),
          `speech.engines requires a "mic" capability, which the manifest does not declare`,
        );
        return backend.speech.engines();
      },
      devices() {
        admit(
          hasMicCapability(manifest.capabilities),
          `speech.devices requires a "mic" capability, which the manifest does not declare`,
        );
        return backend.speech.devices();
      },
      startCapture(onLevel, options) {
        admit(
          hasMicCapability(manifest.capabilities),
          `speech.startCapture requires a "mic" capability, which the manifest does not declare`,
        );
        return backend.speech.startCapture(manifest.id, onLevel, options);
      },
    },
    clipboard: {
      writeText(text) {
        admit(
          hasCapability(manifest.capabilities, "clipboardWrite"),
          `clipboard.writeText requires a "clipboardWrite" capability, which the manifest does not declare`,
        );
        return backend.clipboard.writeText(text);
      },
      readText() {
        admit(
          hasCapability(manifest.capabilities, "clipboardRead"),
          `clipboard.readText requires a "clipboardRead" capability, which the manifest does not declare`,
        );
        return backend.clipboard.readText();
      },
    },
  };
}

function hasMicCapability(capabilities: Capability[]): boolean {
  return hasCapability(capabilities, "mic");
}

/** Membership test for a kind with no parameters — the gate's paramless
 * capabilities all reduce to "is this kind declared at all". The kind set is
 * pinned to the paramless union so a scope-bearing kind (fs/git/net/…) can't
 * be passed here by mistake (those need their scope/domain, not membership). */
type ParamlessCapabilityKind =
  | "ports"
  | "open"
  | "mic"
  | "notifications"
  | "clipboardWrite"
  | "clipboardRead";

function hasCapability(
  capabilities: Capability[],
  kind: ParamlessCapabilityKind,
): boolean {
  return capabilities.some((capability) => capability.kind === kind);
}

/** The declared server of that id, from any `exec` capability. */
function rpcServer(capabilities: Capability[], id: string): RpcServerDeclaration | undefined {
  return capabilities
    .flatMap((capability) => (capability.kind === "exec" ? (capability.servers ?? []) : []))
    .find((server) => server.id === id);
}

/** The handshake's `clientInfo` with the plugin's version filled in when it
 * states none — the manifest's `version` is the one place it is written. */
function withClientVersion(server: RpcServerDeclaration, version: string): RpcServerDeclaration {
  const { handshake } = server;
  const params = handshake?.params;
  if (!handshake || !isObjectLike(params) || !isObjectLike(params.clientInfo)) return server;
  if (params.clientInfo.version !== undefined) return server;
  const clientInfo = { ...params.clientInfo, version };
  return { ...server, handshake: { ...handshake, params: { ...params, clientInfo } } };
}

function hasPortsCapability(capabilities: Capability[]): boolean {
  return hasCapability(capabilities, "ports");
}

function hasOpenCapability(capabilities: Capability[]): boolean {
  return hasCapability(capabilities, "open");
}

function hasFsCapability(capabilities: Capability[]): boolean {
  return capabilities.some((capability) => capability.kind === "fs");
}

function hasGitCapability(capabilities: Capability[]): boolean {
  return capabilities.some((capability) => capability.kind === "git");
}

/** The scope the fs backend should enforce: the declared scope, defaulting to
 * the SAFEST (`workspace`) when none is declared. `everywhere` is never assumed
 * — a warn-mode built-in that calls `fs` without declaring it is contained to
 * the workspace, not silently handed the whole filesystem. */
function fsScope(capabilities: Capability[]): FsScope {
  const fs = capabilities.find(
    (capability): capability is Extract<Capability, { kind: "fs" }> =>
      capability.kind === "fs",
  );
  return fs?.scope === "everywhere" ? "everywhere" : "workspace";
}

/** Same safest-default rule as [`fsScope`], for the `git` capability. */
function gitScope(capabilities: Capability[]): FsScope {
  const git = capabilities.find(
    (capability): capability is Extract<Capability, { kind: "git" }> =>
      capability.kind === "git",
  );
  return git?.scope === "everywhere" ? "everywhere" : "workspace";
}
