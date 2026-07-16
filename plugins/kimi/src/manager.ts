import type {
  PluginSessionHandle,
  PluginSessions,
} from "@keepdeck/plugin-api";

const SERVER_START_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_STARTUP_OUTPUT = 32_768;

export interface KimiCompanionManager {
  inspect(): Promise<KimiCompanionInstallation | null>;
  configure(sourceDirectory: string): Promise<void>;
  remove(): Promise<void>;
  dispose(): Promise<void>;
}

export interface KimiCompanionInstallation {
  version: string | null;
  enabled: boolean;
  healthy: boolean;
  owned: boolean;
}

export interface KimiCompanionDescriptor {
  id: string;
  version: string;
  displayName: string;
  resourceDirectoryName: string;
  hookCount: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface ServerAccess {
  origin: string;
  token: string;
}

interface RpcEnvelope<T> {
  code: number;
  msg: string;
  data: T;
}

interface PluginSummary {
  id: string;
  displayName: string;
  version?: string;
  enabled: boolean;
  state: "ok" | "error";
  hasErrors: boolean;
  source: "local-path" | "zip-url" | "github";
  originalSource?: string;
  skillCount: number;
  mcpServerCount: number;
  hookCount: number;
  commandCount: number;
}

/** Kimi exposes plugin management on its authenticated local REST server, but
 * no non-interactive `kimi plugins ...` CLI command. Start a private,
 * foreground, random-port server for exactly one operation, call its public
 * RPC surface, then close the process group. Nothing in Kimi's private stores
 * is read or edited by KeepDeck. */
export function createKimiCompanionManager(
  sessions: PluginSessions,
  companion: KimiCompanionDescriptor,
  fetcher: FetchLike = globalThis.fetch.bind(globalThis),
): KimiCompanionManager {
  const active = new Set<PluginSessionHandle>();
  const requests = new Set<AbortController>();
  const closing = new WeakMap<PluginSessionHandle, Promise<void>>();
  let disposed = false;

  const closeHandle = (handle: PluginSessionHandle): Promise<void> => {
    const existing = closing.get(handle);
    if (existing) return existing;
    const close = handle.close().catch(() => {});
    closing.set(handle, close);
    return close;
  };

  async function withServer<T>(
    operation: (access: ServerAccess, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (disposed) throw disposedError();
    const request = new AbortController();
    requests.add(request);
    const decoder = new TextDecoder();
    let startupOutput = "";
    let readySettled = false;
    let resolveReady!: (access: ServerAccess) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<ServerAccess>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // The spawn can fail or be abandoned before readiness is awaited. Keep
    // event-driven rejection from becoming an unhandled detached promise.
    void ready.catch(() => {});
    const settleReady = (result: ServerAccess | Error) => {
      if (readySettled) return;
      readySettled = true;
      if (result instanceof Error) rejectReady(result);
      else resolveReady(result);
    };

    let abandoned = false;
    let spawn: Promise<PluginSessionHandle>;
    try {
      spawn = sessions.spawn(
        {
          command: "kimi",
          args: [
            "server",
            "run",
            "--foreground",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--log-level",
            "silent",
          ],
          cols: 80,
          rows: 24,
        },
        (event) => {
          if (event.type === "output") {
            startupOutput += decoder.decode(event.bytes, { stream: true });
            if (startupOutput.length > MAX_STARTUP_OUTPUT) {
              startupOutput = startupOutput.slice(-MAX_STARTUP_OUTPUT);
            }
            const access = extractServerAccess(startupOutput);
            if (access) settleReady(access);
            return;
          }
          settleReady(
            new Error(
              `Kimi setup server exited before it became ready${event.code === null ? "" : ` (code ${event.code})`}.`,
            ),
          );
        },
      );
    } catch (error) {
      requests.delete(request);
      throw error;
    }
    void spawn.then(
      (handle) => {
        if (abandoned || disposed || request.signal.aborted) {
          void closeHandle(handle);
        }
      },
      () => {
        // The awaited branch below owns and reports spawn failures. This
        // second branch exists only so the late-handle cleanup observer does
        // not create a separate unhandled rejection.
      },
    );

    let handle: PluginSessionHandle;
    try {
      handle = await withTimeout(
        spawn,
        SERVER_START_TIMEOUT_MS,
        "Timed out starting the Kimi setup server.",
      );
    } catch (error) {
      abandoned = true;
      requests.delete(request);
      throw error;
    }

    if (disposed || request.signal.aborted) {
      abandoned = true;
      requests.delete(request);
      await closeHandle(handle);
      throw disposedError();
    }

    active.add(handle);
    try {
      const access = await withTimeout(
        ready,
        SERVER_START_TIMEOUT_MS,
        "Timed out waiting for the Kimi setup server.",
      );
      throwIfCancelled(request.signal);
      return await operation(access, request.signal);
    } finally {
      requests.delete(request);
      active.delete(handle);
      await closeHandle(handle);
    }
  }

  return {
    inspect() {
      return withServer(async (access, signal) => {
        const plugins = await listPlugins(fetcher, access, signal);
        const plugin = plugins.find((entry) => entry.id === companion.id);
        return plugin
          ? {
              version: plugin.version ?? null,
              enabled: plugin.enabled,
              healthy: plugin.state === "ok" && !plugin.hasErrors,
              owned: isOwnedCompanion(plugin, companion),
            }
          : null;
      });
    },

    configure(sourceDirectory) {
      return withServer(async (access, signal) => {
        const existing = (await listPlugins(fetcher, access, signal)).find(
          (entry) => entry.id === companion.id,
        );
        if (existing && !isOwnedCompanion(existing, companion)) {
          throw ownershipError(companion.id);
        }
        const installed = await callRpc<PluginSummary>(
          fetcher,
          access,
          "installPlugin",
          {
            source: sourceDirectory,
          },
          signal,
        );
        if (
          !isOwnedCompanion(installed, companion) ||
          installed.version !== companion.version ||
          installed.originalSource !== sourceDirectory
        ) {
          throw new Error(
            "Kimi returned an unexpected plugin after installation; it was not enabled.",
          );
        }
        // Re-configuring a previously disabled installation must make its
        // SessionStart hook live again; install may preserve disabled state.
        throwIfCancelled(signal);
        await callRpc(
          fetcher,
          access,
          "setPluginEnabled",
          { id: companion.id, enabled: true },
          signal,
        );
      });
    },

    remove() {
      return withServer(async (access, signal) => {
        const installed = (await listPlugins(fetcher, access, signal)).find(
          (entry) => entry.id === companion.id,
        );
        if (!installed) return;
        if (!isOwnedCompanion(installed, companion)) {
          throw ownershipError(companion.id);
        }
        await callRpc(
          fetcher,
          access,
          "removePlugin",
          { id: companion.id },
          signal,
        );
      });
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const request of requests) request.abort();
      requests.clear();
      const handles = [...active];
      active.clear();
      await Promise.all(handles.map(closeHandle));
    },
  };
}

function listPlugins(
  fetcher: FetchLike,
  access: ServerAccess,
  signal: AbortSignal,
): Promise<PluginSummary[]> {
  return callRpc(fetcher, access, "listPlugins", undefined, signal);
}

async function callRpc<T>(
  fetcher: FetchLike,
  access: ServerAccess,
  method:
    | "listPlugins"
    | "installPlugin"
    | "setPluginEnabled"
    | "removePlugin",
  body?: Record<string, string | boolean>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal) throwIfCancelled(signal);
  const request = new AbortController();
  let timedOut = false;
  const cancel = () => request.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    request.abort();
  }, REQUEST_TIMEOUT_MS);
  const init: RequestInit = {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${access.token}` },
    redirect: "error",
    signal: request.signal,
  };
  if (body) {
    init.headers = {
      ...init.headers,
      "Content-Type": "application/json",
    };
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetcher(
      `${access.origin}/api/v2/pluginService/${method}`,
      init,
    );
  } catch (error) {
    if (timedOut) throw new Error(`Kimi ${method} request timed out.`);
    if (signal?.aborted) throw disposedError();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
  if (response.url && new URL(response.url).origin !== access.origin) {
    throw new Error("Kimi setup API responded from an unexpected origin.");
  }

  let envelope: RpcEnvelope<T> | null = null;
  try {
    envelope = (await response.json()) as RpcEnvelope<T>;
  } catch {
    // The status below is still useful when an older Kimi has no v2 endpoint.
  }
  if (!response.ok || envelope?.code !== 0) {
    const detail = envelope?.msg?.trim();
    throw new Error(
      detail ||
        `Kimi setup API failed (${response.status}). Update Kimi Code and try again.`,
    );
  }
  return envelope.data;
}

/** Parse only authenticated loopback URLs. ANSI styling may split the base
 * URL and token in Kimi's banner, so strip terminal controls first. */
export function extractServerAccess(output: string): ServerAccess | null {
  const plain = stripTerminalControls(output);
  const match = plain.match(
    /http:\/\/127\.0\.0\.1:\d+\/(?:#token=[^\s]+)?/,
  );
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    if (url.hostname !== "127.0.0.1") return null;
    const token = url.hash.startsWith("#token=")
      ? decodeURIComponent(url.hash.slice("#token=".length))
      : "";
    return token ? { origin: url.origin, token } : null;
  } catch {
    return null;
  }
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function isOwnedCompanion(
  plugin: PluginSummary,
  companion: KimiCompanionDescriptor,
): boolean {
  const sourceParts = plugin.originalSource
    ?.replace(/[\\/]+$/, "")
    .split(/[\\/]/);
  const sourceName = sourceParts?.[sourceParts.length - 1];
  return (
    plugin.id === companion.id &&
    plugin.displayName === companion.displayName &&
    plugin.source === "local-path" &&
    sourceName === companion.resourceDirectoryName &&
    plugin.skillCount === 0 &&
    plugin.mcpServerCount === 0 &&
    plugin.hookCount === companion.hookCount &&
    plugin.commandCount === 0
  );
}

function ownershipError(pluginId: string): Error {
  return new Error(
    `A different Kimi plugin already uses the id "${pluginId}". KeepDeck will not modify it.`,
  );
}

function disposedError(): Error {
  return new Error(
    "Kimi setup was cancelled because the KeepDeck plugin stopped.",
  );
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw disposedError();
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
