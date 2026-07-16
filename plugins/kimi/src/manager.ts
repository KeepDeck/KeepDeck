import type {
  PluginSessionHandle,
  PluginSessions,
} from "@keepdeck/plugin-api";

const SERVER_START_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_STARTUP_OUTPUT = 32_768;

export interface KimiCompanionManager {
  inspect(pluginId: string): Promise<KimiCompanionInstallation | null>;
  configure(sourceDirectory: string): Promise<void>;
  remove(pluginId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface KimiCompanionInstallation {
  version: string | null;
  enabled: boolean;
  healthy: boolean;
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
  version?: string;
  enabled: boolean;
  state: "ok" | "error";
}

/** Kimi exposes plugin management on its authenticated local REST server, but
 * no non-interactive `kimi plugins ...` CLI command. Start a private,
 * foreground, random-port server for exactly one operation, call its public
 * RPC surface, then close the process group. Nothing in Kimi's private stores
 * is read or edited by KeepDeck. */
export function createKimiCompanionManager(
  sessions: PluginSessions,
  fetcher: FetchLike = globalThis.fetch.bind(globalThis),
): KimiCompanionManager {
  const active = new Set<PluginSessionHandle>();

  async function withServer<T>(
    operation: (access: ServerAccess) => Promise<T>,
  ): Promise<T> {
    const decoder = new TextDecoder();
    let startupOutput = "";
    let readySettled = false;
    let resolveReady!: (access: ServerAccess) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<ServerAccess>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const settleReady = (result: ServerAccess | Error) => {
      if (readySettled) return;
      readySettled = true;
      if (result instanceof Error) rejectReady(result);
      else resolveReady(result);
    };

    let abandoned = false;
    const spawn = sessions.spawn(
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
    void spawn.then(
      (handle) => {
        if (abandoned) void handle.close().catch(() => {});
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
      throw error;
    }

    active.add(handle);
    try {
      const access = await withTimeout(
        ready,
        SERVER_START_TIMEOUT_MS,
        "Timed out waiting for the Kimi setup server.",
      );
      return await operation(access);
    } finally {
      active.delete(handle);
      await handle.close().catch(() => {});
    }
  }

  return {
    inspect(pluginId) {
      return withServer(async (access) => {
        const plugins = await callRpc<PluginSummary[]>(
          fetcher,
          access,
          "listPlugins",
        );
        const plugin = plugins.find((entry) => entry.id === pluginId);
        return plugin
          ? {
              version: plugin.version ?? null,
              enabled: plugin.enabled,
              healthy: plugin.state === "ok",
            }
          : null;
      });
    },

    configure(sourceDirectory) {
      return withServer(async (access) => {
        const installed = await callRpc<PluginSummary>(
          fetcher,
          access,
          "installPlugin",
          {
            source: sourceDirectory,
          },
        );
        // Re-configuring a previously disabled installation must make its
        // SessionStart hook live again; install may preserve disabled state.
        await callRpc(fetcher, access, "setPluginEnabled", {
          id: installed.id,
          enabled: true,
        });
      });
    },

    remove(pluginId) {
      return withServer(async (access) => {
        await callRpc(fetcher, access, "removePlugin", { id: pluginId });
      });
    },

    async dispose() {
      const handles = [...active];
      active.clear();
      await Promise.all(handles.map((handle) => handle.close().catch(() => {})));
    },
  };
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
): Promise<T> {
  const init: RequestInit = {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${access.token}` },
  };
  if (body) {
    init.headers = {
      ...init.headers,
      "Content-Type": "application/json",
    };
    init.body = JSON.stringify(body);
  }
  const response = await withTimeout(
    fetcher(`${access.origin}/api/v2/pluginService/${method}`, init),
    REQUEST_TIMEOUT_MS,
    `Kimi ${method} request timed out.`,
  );

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
    /http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/(?:#token=[^\s]+)?/,
  );
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    if (!isLoopback(url.hostname)) return null;
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

function isLoopback(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]"
  );
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
