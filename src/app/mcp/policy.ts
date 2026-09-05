import { describeError, log } from "../../ipc/log";

/** The backend calls the policy drives — injectable for tests. */
export interface McpTransportPort {
  enable(): Promise<unknown>;
  disable(): Promise<unknown>;
}

/** What one settled enable reported: whether the backend confirmed it, and
 * the socket path (success) or the failure message. The service builds
 * user-facing status from these — the policy itself keeps no public state. */
export interface McpTransition {
  ok: boolean;
  detail: string | null;
}

export interface McpServerPolicy {
  /** Try again after a refused enable. A no-op while an enable is in flight
   * or the last one was confirmed, so a settings surface may call it on
   * every mount without stacking calls — and after dispose, which is final. */
  ensure(): void;
  /** Stop. `disable: true` additionally queues a FINAL disable onto the same
   * chain every other backend call rides — an in-flight enable settles first,
   * so a disposed page can never lose that race and leave the socket up with
   * nobody answering. */
  dispose(options?: { disable?: boolean }): void;
}

/**
 * Keep the backend socket up for the life of the page. The transport has no
 * setting: it comes up when the service is built and goes down when the page
 * does, so the only decision left here is what a FAILURE means. A refused
 * enable (another instance holds the socket, no home directory) logs,
 * reports, and clears the applied mark so the next `ensure` retries, rather
 * than trusting a state the backend never confirmed.
 *
 * Backend calls are SERIALIZED through one chain: the final disable must
 * land after the enable it undoes, never interleaved with it. Only one
 * enable can be outstanding — a second is queued only once the first has
 * failed — so a failure always belongs to the latest call.
 */
export function createMcpServerPolicy(
  // Both REQUIRED: the service is the one owner of the transport binding
  // and the one consumer of transitions — a default here would be a second
  // home for the former and a silent drop of the latter.
  transport: McpTransportPort,
  report: (transition: McpTransition) => void,
): McpServerPolicy {
  /** An enable was handed to the backend and has not failed since. */
  let applied = false;
  let disposed = false;
  let chain: Promise<void> = Promise.resolve();

  const ensure = () => {
    if (disposed || applied) return;
    applied = true;
    chain = chain.then(async () => {
      try {
        const value = await transport.enable();
        report({ ok: true, detail: typeof value === "string" ? value : null });
      } catch (e) {
        const detail = describeError(e);
        log.warn("web:mcp", `mcp enable failed: ${detail}`);
        report({ ok: false, detail });
        applied = false;
      }
    });
  };

  ensure();

  return {
    ensure,
    dispose(options = {}) {
      disposed = true;
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
