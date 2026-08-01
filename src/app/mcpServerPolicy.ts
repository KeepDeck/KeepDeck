import { describeError, log } from "../ipc/log";
import { mcpDisable, mcpEnable } from "../ipc/mcp";

export interface McpSettingsPort {
  /** The toggle's value, or `null` until the settings load settles. */
  mcpServer(): boolean | null;
  subscribe(listener: () => void): () => void;
}

/** The backend calls the policy drives — injectable for tests. */
export interface McpTransportPort {
  enable(): Promise<unknown>;
  disable(): Promise<unknown>;
}

export interface McpServerPolicy {
  dispose(): void;
}

/**
 * Reconcile the durable mcpServer setting with the backend socket. This is
 * application policy, not rendering: it runs at boot (the settings load
 * notifies like any change) and on every toggle flip, whether or not any
 * settings surface is mounted.
 *
 * Backend calls are SERIALIZED through one chain — a fast On→Off flip must
 * arrive as enable-then-disable, never interleaved. A failed call logs and
 * clears the applied mark so the next settings event retries instead of
 * believing the backend reached the state it never confirmed.
 */
export function createMcpServerPolicy(
  settings: McpSettingsPort,
  transport: McpTransportPort = { enable: mcpEnable, disable: mcpDisable },
): McpServerPolicy {
  /** What was last handed to the backend (optimistically) — `null` means
   * "unknown", which always reconciles on the next event. */
  let applied: boolean | null = null;
  let chain: Promise<void> = Promise.resolve();

  const reconcile = () => {
    const desired = settings.mcpServer();
    if (desired === null || desired === applied) return;
    applied = desired;
    chain = chain.then(async () => {
      try {
        await (desired ? transport.enable() : transport.disable());
      } catch (e) {
        log.warn(
          "web:mcp",
          `mcp ${desired ? "enable" : "disable"} failed: ${describeError(e)}`,
        );
        if (applied === desired) applied = null;
      }
    });
  };

  const unsubscribe = settings.subscribe(reconcile);
  reconcile();

  return {
    dispose() {
      unsubscribe();
    },
  };
}
