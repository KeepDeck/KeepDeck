import { INTERNAL_ERROR, errorReply } from "../domain/mcp/jsonrpc";
import { describeError, log } from "../ipc/log";
import { onMcpRequest, respondMcp, type McpRequest } from "../ipc/mcpBridge";

/** Answers one request line with at most one reply line — the projection
 * layer. `null` means "no reply": notifications must never be answered, and
 * the Rust side parked nothing for them. */
export type McpLineHandler = (
  line: string,
) => Promise<string | null> | string | null;

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
        let reply: string | null;
        try {
          reply = await handleLine(line);
        } catch (e) {
          reply = errorReply(line, INTERNAL_ERROR, describeError(e));
        }
        if (reply === null) {
          // Only the TRANSPORT knows whether a slot is parked for this
          // line — id 0 is its "no reply expected" sentinel. The projection
          // declining any other id (the two sides can disagree on what
          // counts as a notification — parsers differ) must still answer,
          // or the client pays the bridge's full timeout for silence.
          if (id === 0) return;
          reply = errorReply(
            line,
            INTERNAL_ERROR,
            "the deck produced no reply for this request",
          );
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
    })
    .catch((e) => {
      // No subscription means no inbound requests, ever — worth a warning,
      // not a crash: the socket side still answers with its own timeout.
      log.warn("web:mcp", `request subscription failed: ${describeError(e)}`);
    });

  return {
    dispose() {
      disposed = true;
      unlisten?.();
      unlisten = null;
    },
  };
}
