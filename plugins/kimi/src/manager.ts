import type {
  KimiServerAccess,
  KimiServerManager,
} from "./serverManager";

const REQUEST_TIMEOUT_MS = 15_000;

export interface KimiCompanionManager {
  inspect(): Promise<KimiCompanionInstallation | null>;
  configure(sourceDirectory: string): Promise<KimiCompanionInstallation>;
  remove(): Promise<KimiCompanionInstallation | null>;
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

/** Performs reporter RPC transactions on the one server owned by
 * KimiServerManager. Configure and Remove verify their final state before the
 * transaction releases that server, so the controller never needs a second
 * setup-server launch. */
export function createKimiCompanionManager(
  server: KimiServerManager,
  companion: KimiCompanionDescriptor,
  fetcher: FetchLike = globalThis.fetch.bind(globalThis),
): KimiCompanionManager {
  return {
    inspect() {
      return server.run(async (access, signal) => {
        const plugin = await findCompanion(
          fetcher,
          access,
          signal,
          companion.id,
        );
        return plugin ? installationFrom(plugin, companion) : null;
      });
    },

    configure(sourceDirectory) {
      return server.run(async (access, signal) => {
        const existing = await findCompanion(
          fetcher,
          access,
          signal,
          companion.id,
        );
        if (existing && !isOwnedCompanion(existing, companion)) {
          throw ownershipError(companion.id);
        }

        const installed = await callRpc<PluginSummary>(
          fetcher,
          access,
          "installPlugin",
          { source: sourceDirectory },
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

        throwIfCancelled(signal);
        await callRpc(
          fetcher,
          access,
          "setPluginEnabled",
          { id: companion.id, enabled: true },
          signal,
        );

        const verified = await findCompanion(
          fetcher,
          access,
          signal,
          companion.id,
        );
        if (!verified) {
          throw new Error(
            "Kimi did not retain the installed KeepDeck reporter.",
          );
        }
        const installation = installationFrom(verified, companion);
        if (
          !installation.owned ||
          !installation.enabled ||
          !installation.healthy ||
          installation.version !== companion.version
        ) {
          throw new Error(
            "Kimi could not verify the configured KeepDeck reporter.",
          );
        }
        return installation;
      });
    },

    remove() {
      return server.run(async (access, signal) => {
        const installed = await findCompanion(
          fetcher,
          access,
          signal,
          companion.id,
        );
        if (!installed) return null;
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
        const remaining = await findCompanion(
          fetcher,
          access,
          signal,
          companion.id,
        );
        if (remaining) {
          throw new Error("Kimi did not remove the KeepDeck reporter.");
        }
        return null;
      });
    },

    dispose: () => server.dispose(),
  };
}

async function findCompanion(
  fetcher: FetchLike,
  access: KimiServerAccess,
  signal: AbortSignal,
  pluginId: string,
): Promise<PluginSummary | null> {
  const plugins = await callRpc<PluginSummary[]>(
    fetcher,
    access,
    "listPlugins",
    undefined,
    signal,
  );
  return plugins.find((entry) => entry.id === pluginId) ?? null;
}

async function callRpc<T>(
  fetcher: FetchLike,
  access: KimiServerAccess,
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
      `${access.origin}/api/v1/debug/pluginService/${method}`,
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
    // The status below is still useful when the server has no debug surface
    // (an older Kimi, or a non-loopback bind where Kimi refuses to mount it).
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

function installationFrom(
  plugin: PluginSummary,
  companion: KimiCompanionDescriptor,
): KimiCompanionInstallation {
  return {
    version: plugin.version ?? null,
    enabled: plugin.enabled,
    healthy: plugin.state === "ok" && !plugin.hasErrors,
    owned: isOwnedCompanion(plugin, companion),
  };
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
