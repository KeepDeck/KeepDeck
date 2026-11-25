import { useMcpStatus } from "../../app/mcp/useMcpStatus";
import { mcpTransportLine } from "../../presentation/mcpWords";

/**
 * The MCP server's row in General ([F6]): what the transport is doing, and
 * whom it serves.
 *
 * There is no switch. The socket comes up with the page and stays up, so the
 * row states a FACT about the running transport, never a wish: it keys on the
 * CONFIRMED status, and a refused enable (another instance already holds the
 * socket, no home directory) is said as such. There is no command to copy:
 * the server is handed to each agent pane with a secret of its own, and a
 * program wired up by hand would be refused.
 */
export function McpServerRow() {
  const status = useMcpStatus();
  return (
    <>
      <span className="form__label">MCP server</span>
      <span className="settings__hint kd-selectable">{mcpTransportLine(status.socket, status.error)}</span>
      <span className="settings__hint">
        Exposes the deck’s commands (list workspaces, spawn agents, send
        text…) to the agents in KeepDeck panes over a local socket, so they
        can drive KeepDeck.
      </span>
    </>
  );
}
