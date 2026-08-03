import type { ArgSpec, CommandArgs, CommandInfo, CommandResult } from "../commands";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  errorReply,
  resultReply,
} from "./jsonrpc";

/**
 * The MCP projection: the command registry, spoken as an MCP server. One
 * line in, at most one line out — pure over an injected port, so the whole
 * protocol is testable without a socket, a webview or a registry.
 *
 * Only protocol-level failures become JSON-RPC errors (unknown tool, bad
 * argument shape); a command that runs and FAILS is a successful tools/call
 * whose result says `isError` — that split is the MCP contract, and it is
 * what lets a client distinguish "the deck refused" from "ask differently".
 */

/** The newest protocol revision this projection implements. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpServerIdentity {
  name: string;
  version: string;
}

/** What the projection needs from the registry — list and execute; the
 * caller binds the external source identity. */
export interface McpCommandPort {
  list(): CommandInfo[];
  /** `client` is what THIS connection introduced itself as, unresolved — the
   * caller binds it to a source identity (or to none). */
  execute(
    id: string,
    args: CommandArgs,
    client: string | null,
  ): Promise<CommandResult>;
}

/** A registry id as an MCP tool name: external tool-name grammars are
 * `[a-zA-Z0-9_-]` (no dots), so the namespace dots flatten to underscores.
 * The reverse mapping is never parsed back — tools/call resolves through
 * the same projection of the CURRENT list. */
export function toolNameOf(commandId: string): string {
  return commandId.replace(/\./g, "_");
}

/** JSON Schema for a command's flat argument bag. */
function schemaOf(args: ArgSpec[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const arg of args) {
    properties[arg.name] = { type: arg.type, description: arg.description };
    if (arg.required) required.push(arg.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/** The projected tool list plus the name→command index tools/call resolves
 * through. A name collision after dot-flattening keeps the FIRST command
 * (registration order) — deterministic, and the loser stays reachable
 * through every other invoker. */
function projectTools(list: CommandInfo[]): {
  tools: Record<string, unknown>[];
  byName: Map<string, CommandInfo>;
} {
  const tools: Record<string, unknown>[] = [];
  const byName = new Map<string, CommandInfo>();
  for (const info of list) {
    const name = toolNameOf(info.id);
    if (byName.has(name)) continue;
    byName.set(name, info);
    tools.push({
      name,
      description: info.title,
      inputSchema: schemaOf(info.args),
    });
  }
  return { tools, byName };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Answer one MCP line. `null` means "no reply" — notifications never get
 * one. Unparseable input is treated as a failed REQUEST (parse-error reply,
 * id null): the sender clearly wanted something, and silence would cost it
 * a transport timeout instead of an answer.
 */
export async function handleMcpLine(
  port: McpCommandPort,
  identity: () => McpServerIdentity,
  line: string,
  /** Who is asking, as the transport heard it — passed through to `execute`
   * verbatim, because resolving a name is not this projection's business. */
  client: string | null = null,
): Promise<string | null> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return errorReply(line, PARSE_ERROR, "the request is not valid JSON");
  }
  if (!isRecord(message)) {
    return errorReply(line, INVALID_REQUEST, "the request is not an object");
  }
  const hasId = "id" in message;
  const method = message.method;
  if (typeof method !== "string") {
    return hasId
      ? errorReply(line, INVALID_REQUEST, "the request names no method")
      : null;
  }
  const params = isRecord(message.params) ? message.params : {};

  // Notifications (no id) are consumed, never answered — replying would
  // violate JSON-RPC and confuse the client's framing.
  if (!hasId) return null;

  switch (method) {
    case "initialize": {
      // Version negotiation per spec: echo the requested revision IF this
      // projection supports it, else answer with one it does — and it
      // implements exactly one (2025-06-18 semantics; e.g. the JSON-RPC
      // batching that 2025-03-26 requires is deliberately absent here), so
      // the honest reply is constant. Claiming an arbitrary requested
      // string would promise semantics this code refuses to speak.
      return resultReply(line, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: identity(),
      });
    }

    case "ping":
      return resultReply(line, {});

    case "tools/list":
      return resultReply(line, { tools: projectTools(port.list()).tools });

    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") {
        return errorReply(line, INVALID_PARAMS, "tools/call names no tool");
      }
      const command = projectTools(port.list()).byName.get(name);
      if (!command) {
        return errorReply(line, INVALID_PARAMS, `unknown tool "${name}"`);
      }
      const rawArgs = params.arguments;
      if (rawArgs !== undefined && !isRecord(rawArgs)) {
        return errorReply(line, INVALID_PARAMS, "arguments must be an object");
      }
      // Value types are the registry's own validation — it answers with the
      // exact problem list, which maps below.
      const args = (rawArgs ?? {}) as CommandArgs;
      let outcome: CommandResult;
      try {
        outcome = await port.execute(command.id, args, client);
      } catch (e) {
        // The registry contract never throws; a port that does anyway is an
        // internal fault, not a tool failure.
        return errorReply(
          line,
          INTERNAL_ERROR,
          e instanceof Error ? e.message : String(e),
        );
      }
      if (outcome.ok) {
        return resultReply(line, {
          content: [{ type: "text", text: JSON.stringify(outcome.value, null, 2) }],
          isError: false,
        });
      }
      // Argument problems are protocol errors; a command that ran and
      // failed is a tool result that says so.
      if (
        outcome.error.code === "invalid-args" ||
        outcome.error.code === "unknown-command"
      ) {
        return errorReply(line, INVALID_PARAMS, outcome.error.message);
      }
      return resultReply(line, {
        content: [{ type: "text", text: outcome.error.message }],
        isError: true,
      });
    }

    default:
      return errorReply(line, METHOD_NOT_FOUND, `unknown method "${method}"`);
  }
}
