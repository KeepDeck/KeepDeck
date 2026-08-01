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

/** The request's id, when the line parses and carries a valid one. Booleans,
 * objects and fractions are NOT valid ids — answering with one would make
 * the reply unroutable, so they degrade to null like garbage input. */
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
  if (typeof id === "number" && Number.isInteger(id)) return id;
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
