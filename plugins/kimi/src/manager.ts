import type {
  KimiServerAccess,
  KimiServerManager,
} from "./serverManager";
import { sha256Hex } from "./companion";

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
  /** The installed script files match what this build ships. The version
   * above can read "current" while the bytes lie — the wire broke exactly
   * that way once — so this is a separate verdict, and a negative one is
   * what turns an installed reporter "outdated" for the controller. */
  scriptsCurrent: boolean;
}

export interface KimiCompanionDescriptor {
  id: string;
  version: string;
  displayName: string;
  resourceDirectoryName: string;
  /** The files whose drift breaks the pane wire, pinned by digest — see
   * [`CompanionScript`]. Empty for a companion with no wire of its own. */
  scripts: readonly { file: string; sha256: string }[];
}

/** The managed copy's files, as inspect needs them. Kept a PORT because
 * reading another application's home is a capability question the caller
 * (the plugin's activate) answers, not this manager.
 *
 * The two absence shapes are deliberately different outcomes. A MISSING
 * file is a state — scripts drift like any other, and the controller's
 * refresh reinstalls it, so inspect answers "not current" and the
 * self-heal runs. An UNREADABLE file is a failure — the refresh it would
 * trigger cannot fix what it cannot read, so inspect refuses (throws) and
 * the controller shows the error instead of looping a configure that
 * would change nothing. */
export interface InstalledScripts {
  /** Files present in the managed directory; null when the directory
   * itself is gone. Read-only: the manager asks what is there, never
   * changes it. */
  list(): Promise<ReadonlySet<string> | null>;
  /** One installed file's text. Rejects when the file cannot be read. */
  read(file: string): Promise<string>;
  /** The bytes THIS build ships, by file name — the expected side. */
  shipped(): Promise<ReadonlyMap<string, string>>;
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
}

/** Performs reporter RPC transactions on the one server owned by
 * KimiServerManager. Configure and Remove verify their final state before the
 * transaction releases that server, so the controller never needs a second
 * setup-server launch. */
export function createKimiCompanionManager(
  server: KimiServerManager,
  companion: KimiCompanionDescriptor,
  installed: InstalledScripts,
  fetcher: FetchLike = globalThis.fetch.bind(globalThis),
): KimiCompanionManager {
  /** Whether every wire-critical file matches what this build ships.
   *
   * The comparison is against the SHIPPED bytes, not the descriptor's
   * recorded digests: a build whose resources and descriptor have drifted
   * apart (a packaging bug the digest test exists to catch) must still
   * converge — install ships the new bytes, the next inspect sees them
   * match, done. Comparing against the descriptor instead would loop that
   * refresh forever, one configure per check.
   *
   * An EMPTY shipped map is not drift: this build carries no copy of the
   * file to compare or install (a bundle-less dev tree), and "current" for
   * such a build has always meant what its configure() could do — nothing. */
  const scriptsCurrent = async (): Promise<boolean> => {
    if (companion.scripts.length === 0) return true;
    const expected = await installed.shipped();
    if (expected.size === 0) return true;
    const names = await installed.list();
    if (names === null) return false;
    for (const { file } of companion.scripts) {
      if (!names.has(file)) return false;
      const text = await installed.read(file);
      if ((await sha256Hex(text)) !== expected.get(file)) return false;
    }
    return true;
  };

  return {
    inspect() {
      return server.run(async (access, signal) => {
        const plugin = await findCompanion(
          fetcher,
          access,
          signal,
          companion.id,
        );
        if (!plugin) return null;
        const installation = installationFrom(plugin, companion);
        return { ...installation, scriptsCurrent: await scriptsCurrent() };
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
        // The post-install check reads the wire verdict too: an install
        // that ended with drifted bytes (a copy half-written, a version the
        // server lied about) must refuse here, where the reason is fresh —
        // not surface as an "outdated" a moment later.
        return { ...installation, scriptsCurrent: await scriptsCurrent() };
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

/** Everything an installation is EXCEPT whether its scripts are current —
 * that answer needs the managed directory, which this reading of the RPC
 * summary never touches. Callers add it; the type says they must. */
function installationFrom(
  plugin: PluginSummary,
  companion: KimiCompanionDescriptor,
): Omit<KimiCompanionInstallation, "scriptsCurrent"> {
  return {
    version: plugin.version ?? null,
    enabled: plugin.enabled,
    healthy: plugin.state === "ok" && !plugin.hasErrors,
    owned: isOwnedCompanion(plugin, companion),
  };
}

/** Whether the installed plugin is OUR companion — any version of it.
 *
 * Identity is judged on the facts that stay true across every version we
 * ship: our id, our display name, a local-path install, and our resource
 * directory's name. Deliberately NOT on manifest shape (hook/skill/command
 * counts): those change whenever the companion grows a feature, and pinning
 * them turned the 1.2.0→1.3.0 hook additions into a permanent "Plugin ID
 * conflict" with no way out — the ownership gate fires before the version
 * gate, and both configure() and remove() refuse unowned plugins. An old
 * version of ours must read as OURS-but-outdated, never as a stranger. */
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
    sourceName === companion.resourceDirectoryName
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
