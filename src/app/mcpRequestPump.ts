import { INTERNAL_ERROR, errorReply } from "../domain/mcp/jsonrpc";
import { describeError, log } from "../ipc/log";
import { onMcpRequest, respondMcp, type McpRequest } from "../ipc/mcpBridge";

/** Answers one request line with one reply line — the projection layer. */
export type McpLineHandler = (line: string) => Promise<string> | string;

/** The transport legs the pump sits between — injectable for tests. */
export interface McpPumpPorts {
  subscribe(handler: (request: McpRequest) => void): Promise<() => void>;
  respond(id: number, reply: string): Promise<void>;
}

export interface McpRequestPump {
  dispose(): void;
}

/**
 * Answer EVERY socket request with exactly one reply. A handler that throws
 * still answers (JSON-RPC internal error, request id echoed): silence would
 * cost the client the bridge's full 30s timeout per request, and the parked
 * connection thread with it. A reply that fails to deliver is logged — the
 * Rust side has already abandoned or will time the slot out, so there is
 * nothing better to do from here.
 */
export function createMcpRequestPump(
  handleLine: McpLineHandler,
  ports: McpPumpPorts = { subscribe: onMcpRequest, respond: respondMcp },
): McpRequestPump {
  let disposed = false;
  let unlisten: (() => void) | null = null;

  void ports
    .subscribe(({ id, line }) => {
      if (disposed) return;
      void (async () => {
        let reply: string;
        try {
          reply = await handleLine(line);
        } catch (e) {
          reply = errorReply(line, INTERNAL_ERROR, describeError(e));
        }
        try {
          await ports.respond(id, reply);
        } catch (e) {
          log.warn(
            "web:mcp",
            `reply ${id} failed to deliver: ${describeError(e)}`,
          );
        }
      })();
    })
    .then((un) => {
      // Disposed while the subscription was still settling: release it now,
      // or the dead pump would keep consuming events forever.
      if (disposed) un();
      else unlisten = un;
    });

  return {
    dispose() {
      disposed = true;
      unlisten?.();
      unlisten = null;
    },
  };
}
