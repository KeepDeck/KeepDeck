import { describeError, log } from "../../ipc/log";

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

/** What one settled backend call reported: what was asked, whether the
 * backend confirmed it, and the socket path (successful enable) or the
 * failure message. The service builds user-facing status from these — the
 * policy itself keeps no public state. */
export interface McpTransition {
  desired: boolean;
  ok: boolean;
  detail: string | null;
}

export interface McpServerPolicy {
  /** Stop reconciling. `disable: true` additionally queues a FINAL disable
   * onto the same chain every other backend call rides — an in-flight
   * enable settles first, so a disposed page can never lose that race and
   * leave the socket up with nobody answering. */
  dispose(options?: { disable?: boolean }): void;
}

/**
 * Reconcile the durable mcpServer setting with the backend socket. This is
 * application policy, not rendering: it runs at boot (the settings load
 * notifies like any change) and on every toggle flip, whether or not any
 * settings surface is mounted.
 *
 * Backend calls are SERIALIZED through one chain — a fast On→Off flip must
 * arrive as enable-then-disable, never interleaved. A failed call logs,
 * reports, and clears the applied mark so the next settings event retries —
 * but only when it was the LATEST call: an older failure must not clear a
 * mark a newer event already re-established (the epoch guard).
 */
export function createMcpServerPolicy(
  settings: McpSettingsPort,
  // Both REQUIRED: the service is the one owner of the transport binding
  // and the one consumer of transitions — a default here would be a second
  // home for the former and a silent drop of the latter.
  transport: McpTransportPort,
  report: (transition: McpTransition) => void,
): McpServerPolicy {
  /** What was last handed to the backend (optimistically) — `null` means
   * "unknown", which always reconciles on the next event. */
  let applied: boolean | null = null;
  let epoch = 0;
  let disposed = false;
  let chain: Promise<void> = Promise.resolve();

  const reconcile = () => {
    // Unsubscribing is not enough: a notifier that iterates a SNAPSHOT of
    // its listeners can still call us after dispose, and queueing an
    // enable behind the final disable would undo the teardown.
    if (disposed) return;
    const desired = settings.mcpServer();
    if (desired === null || desired === applied) return;
    applied = desired;
    const call = ++epoch;
    chain = chain.then(async () => {
      try {
        const value = await (desired
          ? transport.enable()
          : transport.disable());
        report({
          desired,
          ok: true,
          detail: typeof value === "string" ? value : null,
        });
      } catch (e) {
        const detail = describeError(e);
        log.warn(
          "web:mcp",
          `mcp ${desired ? "enable" : "disable"} failed: ${detail}`,
        );
        report({ desired, ok: false, detail });
        if (epoch === call) applied = null;
      }
    });
  };

  const unsubscribe = settings.subscribe(reconcile);
  reconcile();

  return {
    dispose(options = {}) {
      disposed = true;
      unsubscribe();
      if (options.disable) {
        chain = chain.then(async () => {
          try {
            await transport.disable();
          } catch (e) {
            log.warn("web:mcp", `final disable failed: ${describeError(e)}`);
          }
        });
      }
    },
  };
}
