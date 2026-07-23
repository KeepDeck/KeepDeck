import type {
  Capability,
  DownloadRequest,
  DownloadTarget,
  Disposable,
  FsEntry,
  FsFile,
  FsReadFileOptions,
  GitBranches,
  GitChangedFile,
  GitDiffOptions,
  GitHistory,
  GitHistoryOptions,
  GitStatus,
  PluginLogger,
  PluginManifest,
  PluginOpener,
  PluginPorts,
  PluginServices,
  PluginSessions,
  PluginSpeech,
} from "@keepdeck/plugin-api";
import { execCovers } from "./execCovers";

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
  watch(path: string, scope: FsScope, onChange: () => void): Disposable;
}

/** The prefix-aware write backend the gate wraps: the gate passes the
 * manifest's DECLARED `fsWrite` prefixes with every call; the host enforces
 * containment against them (both ends of a copy). The plugin never supplies
 * the prefixes — the manifest is the only source. */
export interface FsWriteBackend {
  mkdir(path: string, roots: readonly string[]): Promise<void>;
  copyFile(src: string, dst: string, roots: readonly string[]): Promise<void>;
  writeFile(path: string, text: string, roots: readonly string[]): Promise<void>;
  appendLine(path: string, line: string, roots: readonly string[]): Promise<void>;
}

/** The prefix-aware read-only SQL backend, mirroring [`FsWriteBackend`]. */
export interface SqliteBackend {
  query(
    dbPath: string,
    sql: string,
    params: string[],
    roots: readonly string[],
  ): Promise<(string | null)[][]>;
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
  ): Promise<string>;
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
  watch(repo: string, scope: FsScope, onChange: () => void): Disposable;
}

/** The ungated platform backends the gate decorates. Identical to
 * `PluginServices` except `fs`/`git`: those backends are scope-aware (the gate
 * injects the scope), while the services the gate RETURNS match the public,
 * scope-free contracts the plugin calls. */
export interface ServiceBackends {
  sessions: PluginSessions;
  ports: PluginPorts;
  opener: PluginOpener;
  fs: FsBackend;
  fsWrite: FsWriteBackend;
  sqlite: SqliteBackend;
  git: GitBackend;
  downloads: {
    start(
      pluginId: string,
      request: DownloadRequest,
      allowedDomains: readonly string[],
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
    startCapture(
      pluginId: string,
      onLevel?: Parameters<PluginSpeech["startCapture"]>[0],
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
 * `downloads` applies the declared `net` domains both before dispatch and in
 * the native transfer engine, including every redirect.
 */
export type GateDiagnostics = "log" | "silent";

export function createCapabilityGate(
  manifest: PluginManifest,
  backend: ServiceBackends,
  opts: { diagnostics: GateDiagnostics; log: PluginLogger },
): PluginServices {
  const { diagnostics, log } = opts;
  const maxActiveDownloads = 8;
  const activeDownloadIds = new Set<string>();

  /** One authorization path. Diagnostics add visibility, never authority. */
  function admit(ok: boolean, message: string): void {
    if (ok) return;
    if (diagnostics === "log") log.warn(message);
    throw new Error(message);
  }

  function finishDownload(id: string): void {
    activeDownloadIds.delete(id);
  }

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
    fs: {
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
    },
    fsWrite: {
      mkdir(path) {
        admit(
          fsWritePaths(manifest.capabilities).length > 0,
          `fsWrite.mkdir: "${path}" requires an "fsWrite" capability, which the manifest does not declare`,
        );
        return backend.fsWrite.mkdir(path, fsWritePaths(manifest.capabilities));
      },
      copyFile(src, dst) {
        admit(
          fsWritePaths(manifest.capabilities).length > 0,
          `fsWrite.copyFile: "${dst}" requires an "fsWrite" capability, which the manifest does not declare`,
        );
        return backend.fsWrite.copyFile(src, dst, fsWritePaths(manifest.capabilities));
      },
      writeFile(path, text) {
        admit(
          fsWritePaths(manifest.capabilities).length > 0,
          `fsWrite.writeFile: "${path}" requires an "fsWrite" capability, which the manifest does not declare`,
        );
        return backend.fsWrite.writeFile(path, text, fsWritePaths(manifest.capabilities));
      },
      appendLine(path, line) {
        admit(
          fsWritePaths(manifest.capabilities).length > 0,
          `fsWrite.appendLine: "${path}" requires an "fsWrite" capability, which the manifest does not declare`,
        );
        return backend.fsWrite.appendLine(path, line, fsWritePaths(manifest.capabilities));
      },
    },
    sqlite: {
      query(dbPath, sql, params) {
        admit(
          sqlitePaths(manifest.capabilities).length > 0,
          `sqlite.query: "${dbPath}" requires a "sqliteReadonly" capability, which the manifest does not declare`,
        );
        return backend.sqlite.query(
          dbPath,
          sql,
          params ?? [],
          sqlitePaths(manifest.capabilities),
        );
      },
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
        return backend.git.diffFile(
          repo,
          file,
          gitScope(manifest.capabilities),
          opts,
        );
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
    downloads: {
      start(request) {
        admit(
          netCovers(manifest.capabilities, request.source.url),
          `downloads.start: "${request.source.url}" requires a matching "net" capability`,
        );
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
        const stream = backend.downloads.start(
          manifest.id,
          request,
          netDomains(manifest.capabilities),
          () => {
            terminal = true;
            finishDownload(request.id);
          },
        );
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
      startCapture(onLevel) {
        admit(
          hasMicCapability(manifest.capabilities),
          `speech.startCapture requires a "mic" capability, which the manifest does not declare`,
        );
        return backend.speech.startCapture(manifest.id, onLevel);
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

/** Membership test for a kind with no parameters (ports, open, mic,
 * notifications, clipboardWrite, clipboardRead) — the gate's paramless
 * capabilities all reduce to "is this kind declared at all". */
function hasCapability(
  capabilities: Capability[],
  kind: Extract<Capability, { kind: string }>["kind"],
): boolean {
  return capabilities.some((capability) => capability.kind === kind);
}

function netCovers(capabilities: Capability[], rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).host;
  } catch {
    return false;
  }
  return netDomains(capabilities).some(
    (domain) => domain.toLowerCase() === host.toLowerCase(),
  );
}

function netDomains(capabilities: Capability[]): string[] {
  return capabilities.flatMap((capability) =>
    capability.kind === "net" ? capability.domains : [],
  );
}

function hasPortsCapability(capabilities: Capability[]): boolean {
  return capabilities.some((capability) => capability.kind === "ports");
}

function hasOpenCapability(capabilities: Capability[]): boolean {
  return capabilities.some((capability) => capability.kind === "open");
}

function hasFsCapability(capabilities: Capability[]): boolean {
  return capabilities.some((capability) => capability.kind === "fs");
}

function hasGitCapability(capabilities: Capability[]): boolean {
  return capabilities.some((capability) => capability.kind === "git");
}

/** The declared `fsWrite` prefixes — empty when the capability is absent
 * (which denies every call; there is no default prefix). */
function fsWritePaths(capabilities: Capability[]): string[] {
  const cap = capabilities.find((capability) => capability.kind === "fsWrite");
  return cap?.kind === "fsWrite" ? cap.paths : [];
}

/** The declared `sqliteReadonly` prefixes — same denial-by-default. */
function sqlitePaths(capabilities: Capability[]): string[] {
  const cap = capabilities.find(
    (capability) => capability.kind === "sqliteReadonly",
  );
  return cap?.kind === "sqliteReadonly" ? cap.paths : [];
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
