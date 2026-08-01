import type { CommandRegistry } from "../domain/commands";
import {
  handleMcpLine,
  type McpCommandPort,
  type McpServerIdentity,
} from "../domain/mcp/protocol";
import { fetchAppInfo } from "../ipc/app";
import { commands } from "./commandRegistry";
import type { McpLineHandler } from "./mcpRequestPump";

/**
 * Bind the pure MCP projection to the live registry. Every call executes as
 * `{kind: "external", client: "mcp"}` — the journal's audit line for socket
 * clients (per-connection identity is the auto-inject work, not v1).
 *
 * The identity is cosmetic (initialize's serverInfo), so it must never gate
 * a request: the fetch fills it in when it lands, and until then — or if it
 * never does — the fallback serves.
 */
export function createMcpLineHandler(
  registry: CommandRegistry = commands,
): McpLineHandler {
  let identity: McpServerIdentity = { name: "KeepDeck", version: "unknown" };
  void fetchAppInfo()
    .then((info) => {
      identity = { name: info.name, version: info.version };
    })
    .catch(() => {});
  const port: McpCommandPort = {
    list: () => registry.list(),
    execute: (id, args) =>
      registry.execute(id, args, { kind: "external", client: "mcp" }),
  };
  return (line) => handleMcpLine(port, () => identity, line);
}
