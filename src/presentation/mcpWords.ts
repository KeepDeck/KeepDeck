import type { McpPageRefusal } from "../domain/mcp";

/** The sentence an MCP client is told for the one refusal the page makes
 * itself. The socket door words its own refusals (src-tauri/src/mcp/bridge.rs). */
export function mcpRefusalText(reason: McpPageRefusal): string {
  switch (reason) {
    case "pane-gone":
      return "the KeepDeck pane this connection speaks for has closed";
  }
}
