/**
 * JSON-RPC 2.0 message shaping for the MCP transport. The socket speaks one
 * JSON object per line (MCP stdio framing); these helpers own the framing
 * rules every layer above shares — most importantly that a reply, error
 * included, echoes the request's id, because correlation is all a client
 * has.
 */

/** A valid JSON-RPC id. `null` also stands in for "unknown" — the reply to
 * a line that never parsed. */
export type JsonRpcId = string | number | null;

/** JSON-RPC 2.0 error codes the transport emits. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/** The request's id, when the line parses and carries a routable one: a
 * string, or an integer-valued number within ±(2^53−1) — the range every
 * JSON parser preserves exactly. Booleans, objects, fractions and larger
 * integers degrade to null like garbage input: JSON.parse has already
 * ROUNDED an id beyond 2^53, and answering with the rounded value would be
 * a lie the client cannot correlate. The exact mirror of `echoable_id` in
 * src-tauri/src/mcp_bridge.rs, pinned by tests on the same inputs. */
export function requestIdOf(line: string): JsonRpcId {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const id = (parsed as { id?: unknown }).id;
  if (typeof id === "string") return id;
  if (typeof id === "number" && Number.isSafeInteger(id)) return id;
  return null;
}

/** One serialized error reply for `line`, id echoed per `requestIdOf`. */
export function errorReply(line: string, code: number, message: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: requestIdOf(line),
    error: { code, message },
  });
}

/** One serialized success reply for `line`, id echoed per `requestIdOf`. */
export function resultReply(line: string, result: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: requestIdOf(line),
    result,
  });
}
