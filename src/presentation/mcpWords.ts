import type { McpPageRefusal } from "../domain/mcp";

/** What the settings row says about the transport: a problem whenever there
 * is one, else whether it is up yet, and who it serves. Never silent: "no
 * row" would read as "no server". */
export function mcpTransportLine(socket: string | null, error: string | null): string {
  if (error !== null) return `The MCP transport reported a problem: ${error}`;
  if (socket === null) return "The server is coming up.";
  return "The server is up. Agent panes started here are given it, each with a secret of its own; programs outside KeepDeck panes are refused.";
}

/** The sentence an MCP client is told for the one refusal the page makes
 * itself. The socket door words its own refusals (src-tauri/src/mcp/bridge.rs). */
export function mcpRefusalText(reason: McpPageRefusal): string {
  switch (reason) {
    case "pane-gone":
      return "the KeepDeck pane this connection speaks for has closed";
  }
}
