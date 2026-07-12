import type {
  Capability,
  Disposable,
  FsEntry,
  FsFile,
  FsReadFileOptions,
  GitDiffOptions,
  GitStatus,
  PluginLogger,
  PluginManifest,
  PluginOpener,
  PluginPorts,
  PluginServices,
  PluginSessions,
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
  git: GitBackend;
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
 * v0 runs only built-in, trusted plugins, so `"warn"` mode exists to turn
 * every future contract violation into a visible tripwire in the log
 * WITHOUT taking the app down — a built-in plugin that outgrows its
 * manifest is a bug to fix, not a reason to crash a user's session. The
 * external plugin tier (untrusted, arbitrary code) will construct this gate
 * with `"enforce"` instead, where the identical violation throws.
 *
 * The gate is pure decoration: it holds no state beyond `manifest`/`backend`
 * and forwards an allowed call verbatim — same arguments, same return value,
 * no re-wrapping of the session handle — so a caller cannot tell a `"warn"`
 * pass-through from a call that was never gated at all.
 *
 * `fs` IS gated here now (a file-reading plugin gave it a service to guard):
 * the gate admits the call only if the manifest declares an `fs` capability and
 * passes the DECLARED SCOPE to the backend, which resolves scope into the roots
 * it enforces containment against — the plugin never supplies the scope. `net`
 * still has no service to gate: it is enforced by the plugin realm's CSP, not a
 * call here, so there is deliberately no `net` branch.
 */
export type GateMode = "warn" | "enforce";

export function createCapabilityGate(
  manifest: PluginManifest,
  backend: ServiceBackends,
  opts: { mode: GateMode; log: PluginLogger },
): PluginServices {
  const { mode, log } = opts;

  /** The single branch point between the two modes, so a violation can
   * never carry two different messages down two paths: `"warn"` logs and
   * returns (the call proceeds below); `"enforce"` throws here, before the
   * backend is ever reached. */
  function admit(ok: boolean, message: string): void {
    if (ok) return;
    if (mode === "enforce") throw new Error(message);
    log.warn(message);
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
      watch(repo, onChange) {
        admit(
          hasGitCapability(manifest.capabilities),
          `git.watch: "${repo}" requires a "git" capability, which the manifest does not declare`,
        );
        return backend.git.watch(repo, gitScope(manifest.capabilities), onChange);
      },
    },
  };
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
