import type { CommandRegistry } from "../domain/commands";
import {
  handleMcpLine,
  type McpCommandPort,
  type McpServerIdentity,
} from "../domain/mcp";
import { fetchAppInfo } from "../ipc/app";
import { mcpDisable, mcpEnable } from "../ipc/mcp";
import { commands } from "./commandRegistry";
import { createMcpRequestPump, type McpPumpPorts } from "./mcpRequestPump";
import {
  createMcpServerPolicy,
  type McpServerPolicy,
  type McpSettingsPort,
  type McpTransition,
  type McpTransportPort,
} from "./mcpServerPolicy";

/** What the app knows about the transport as of the LAST SETTLED
 * transition — confirmed by the backend, not wished by the setting, and
 * not re-probed in between. `socket` is the served path the backend last
 * confirmed; `error` is why the last transition failed — and after a
 * failure the socket claim is KEPT, because nothing confirmed a change
 * (a failed disable most likely leaves the socket serving). */
export interface McpStatus {
  socket: string | null;
  error: string | null;
}

/** The status after one settled transition (see [`McpStatus`] for why a
 * failure keeps the previous socket claim). */
function statusAfter(previous: McpStatus, transition: McpTransition): McpStatus {
  if (!transition.ok) {
    return { socket: previous.socket, error: transition.detail };
  }
  if (!transition.desired) {
    return { socket: null, error: null };
  }
  return transition.detail !== null
    ? { socket: transition.detail, error: null }
    : // Defensive: mcp_enable's contract is a path string; a confirmation
      // without one must degrade LOUDLY, not into a blank served-less On.
      { socket: null, error: "the backend confirmed On without a socket path" };
}

export interface McpService {
  status(): McpStatus;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/** Everything the service touches beyond its own parts — injectable for
 * tests; production uses the defaults. */
export interface McpServiceDeps {
  registry?: CommandRegistry;
  transport?: McpTransportPort;
  pumpPorts?: McpPumpPorts;
  identitySource?: () => Promise<{ name: string; version: string }>;
}

/**
 * The MCP feature's one owner in the webview. Everything the feature IS —
 * the request pump, the registry projection, the settings-driven lifecycle
 * policy, the order they come up in, and the resulting status — lives
 * behind this front door; the composition root holds one handle, and the
 * settings UI reads `status()` instead of re-deriving "the server is on"
 * from the setting (the setting is a wish; the status is what the backend
 * confirmed — they differ exactly when the user most needs to know).
 *
 * Ordering is owned here, in both directions. Up: the policy — and with it
 * the first possible enable — is constructed only after the pump's event
 * subscription has REGISTERED on the backend (`pump.ready`), so a socket
 * client's first request cannot land while nothing is listening; dispatch
 * order alone would not give that, both legs being independent async IPC.
 * Down: the final teardown rides the policy's own serialized chain, so a
 * disposed page can never lose the race against its in-flight enable and
 * leave the socket up with nobody answering.
 */
export function createMcpService(
  settings: McpSettingsPort,
  deps: McpServiceDeps = {},
): McpService {
  const registry = deps.registry ?? commands;
  const transport = deps.transport ?? { enable: mcpEnable, disable: mcpDisable };

  let current: McpStatus = { socket: null, error: null };
  const listeners = new Set<() => void>();
  const publish = (next: McpStatus) => {
    current = next;
    for (const listener of [...listeners]) listener();
  };

  // The identity is cosmetic (initialize's serverInfo) and must never gate
  // a request: the fetch fills it in when it lands; until then — or if it
  // never does — the fallback serves.
  let identity: McpServerIdentity = { name: "KeepDeck", version: "unknown" };
  void (deps.identitySource ?? fetchAppInfo)()
    .then((info) => {
      identity = { name: info.name, version: info.version };
    })
    .catch(() => {});

  const port: McpCommandPort = {
    list: () => registry.list(),
    execute: (id, args) =>
      registry.execute(id, args, { kind: "external", client: "mcp" }),
  };
  const pump = createMcpRequestPump(
    (line) => handleMcpLine(port, () => identity, line),
    deps.pumpPorts,
  );
  let policy: McpServerPolicy | null = null;
  let disposed = false;
  void pump.ready.then(() => {
    if (disposed) return;
    policy = createMcpServerPolicy(settings, transport, (transition) => {
      publish(statusAfter(current, transition));
    });
  });

  return {
    status: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      if (policy) {
        // The teardown rides the policy's chain — a webview on its way out
        // (reload) must not leave the socket serving with nobody to answer,
        // and must not lose the race against its own in-flight enable.
        policy.dispose({ disable: true });
      } else {
        // No policy means nothing was ever enabled BY THIS PAGE — but a
        // predecessor may have left the socket up; best-effort, guarded
        // against a synchronously-throwing injected transport.
        void Promise.resolve()
          .then(() => transport.disable())
          .catch(() => {});
      }
      pump.dispose();
      listeners.clear();
    },
  };
}
