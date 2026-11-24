// @ts-check
/**
 * How this plugin reaches KeepDeck's MCP socket itself, named once for both
 * sides of the process boundary: the launch (src/launch.ts) writes the
 * variable into a 2.x pane, and the deck tools (deck-tools.js) read it inside
 * opencode. Free of Node, like events.js, because the launch is host code.
 */
import { isRecord } from "./guards.js";

/** The variable that carries `{ path, client? }` as JSON. A pane carries it
 * only where the launch decided this plugin, not opencode's MCP client, hands
 * the pane KeepDeck's tools. */
export const DECK_SOCKET_ENV = "KEEPDECK_OPENCODE_DECK";

/** @typedef {{ path: string, client?: string }} DeckSocket */

/** The variable's value for `socket`.
 * @param {DeckSocket} socket */
export function encodeDeckSocket(socket) {
  return JSON.stringify(socket.client === undefined ? { path: socket.path } : { path: socket.path, client: socket.client });
}

/** What the variable says, or undefined when it says nothing usable: a pane
 * without it, or a value no launch wrote.
 * @param {string | undefined} raw
 * @returns {DeckSocket | undefined} */
export function decodeDeckSocket(raw) {
  if (!raw) return undefined;
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { path, client } = value;
  if (typeof path !== "string" || path === "") return undefined;
  if (client === undefined) return { path };
  return typeof client === "string" && client !== "" ? { path, client } : undefined;
}

/** The line a connection opens with, naming its pane. It is byte for byte
 * what the shim writes (src-tauri/src/mcp/shim.rs). Both sides are held to
 * src-tauri/src/mcp/client-greeting.json.
 * @param {string} token */
export function greetingLine(token) {
  return JSON.stringify({ jsonrpc: "2.0", method: "deck/client", params: { token } });
}
