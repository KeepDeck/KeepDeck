// @ts-check
/**
 * KeepDeck's own commands as opencode 2.x tools, called on the deck's MCP
 * socket from this process.
 *
 * Why not opencode's MCP client: on 2.x every MCP server is a child of
 * `opencode serve`, and `serve` runs in a session of its own, outside the
 * pane's terminal. The deck places a socket caller by the kernel's answer
 * about the process on the other end, and a shim there belongs to no pane's
 * terminal. This process IS `serve`, the TUI's child, and the deck places it
 * from its first connection. So the launch gives opencode no `keepdeck` MCP
 * server and hands this component the socket instead (deck-socket.js).
 *
 * Three rules, each measured on 2.4.1:
 * - `setup` never waits for the deck. While any plugin's `setup` is still
 *   pending, the TUI already takes a prompt and runs it on opencode's default
 *   model. The list is asked for in the background and lands through
 *   `tool.reload()`, which only invalidates the registry: the transform below
 *   is replayed on the next read.
 * - One connection per call. The socket answers one connection's requests one
 *   after another, and a model can call two tools at once.
 * - A call is asked and answered as opencode asks and answers for an MCP tool
 *   (packages/core/src/tool/mcp.ts at v2.4.1): the same permission ask, the
 *   same output, and `isError` as a failed call.
 */
import { connect } from "node:net";
import { decodeDeckSocket, DECK_SOCKET_ENV, greetingLine } from "./deck-socket.js";
import { isRecord } from "./guards.js";
import { readBridge } from "./keepdeck-bridge.js";

/** The namespace the tools are filed under, so the model calls
 * `keepdeck_<command>`: the names KeepDeck's MCP server gave them. */
export const NAMESPACE = "keepdeck";

const NAMESPACE_DESCRIPTION = "KeepDeck's commands: mail, the task board, panes and teams of the deck this pane runs in";

/** The turn event that re-lists: a command installed since the last turn
 * is offered from this one on. */
const TURN_STARTED = "session.execution.started";

/** @typedef {{ name: string, description: string, inputSchema: Record<string, unknown> }} DeckTool */
/** @typedef {{ sessionID: string, agent?: string, messageID: string, id: string, signal?: AbortSignal }} CallContext */
/** @typedef {{
 *   namespace: (namespace: { name: string, description: string }) => void,
 *   add: (tool: Record<string, unknown>) => void,
 * }} ToolEditor */
/** @typedef {{
 *   tool: { transform: (edit: (editor: ToolEditor) => void) => Promise<unknown>, reload: () => Promise<void> },
 *   permission: { assert: (input: Record<string, unknown>) => Promise<void> },
 * }} DeckToolsContext */

/** Whether `context` offers what this component uses.
 * @param {unknown} context
 * @returns {context is DeckToolsContext} */
function isDeckToolsContext(context) {
  if (!isRecord(context) || !isRecord(context.tool) || !isRecord(context.permission)) return false;
  return (
    typeof context.tool.transform === "function" &&
    typeof context.tool.reload === "function" &&
    typeof context.permission.assert === "function"
  );
}

/**
 * Offer the deck's commands as tools, for as long as the plugin runs. Inert
 * without the variable, which only a 2.x launch writes, or on a host without
 * the tool domain. Independent of the bridge: the two are separate facts.
 * @param {{ context: unknown }} input
 */
export async function startDeckTools({ context }) {
  const socket = decodeDeckSocket(process.env[DECK_SOCKET_ENV]);
  if (!socket || !isDeckToolsContext(context)) return {};
  // The injected secret first, the inherited one second, as the shim reads
  // them: the deck takes either as the pane's.
  const token = socket.client ?? readBridge()?.token;
  /** @type {Set<import("node:net").Socket>} */
  const open = new Set();
  /** @type {DeckTool[]} */
  let tools = [];
  let listedAs = JSON.stringify(tools);
  let listing = false;
  /** A turn began while a listing was on its way: its answer may predate
   * what that turn should be offered, so one more listing follows it. */
  let again = false;
  let stopped = false;
  /** @type {string | undefined} */
  let reported;

  /** One line when the listing's state changes. opencode gives a 2.x plugin
   * no log, and outside a pane with `/mcps` nothing else would say it. */
  /** @param {string} state */
  const report = (state) => {
    if (state === reported) return;
    reported = state;
    console.error(`keepdeck: ${state}`);
  };

  /** Nothing goes to the deck once the plugin has stopped: a call whose
   * permission was granted after the stop included.
   * @param {string} method @param {Record<string, unknown>} params @param {AbortSignal} [signal] */
  const ask = (method, params, signal) =>
    stopped
      ? Promise.reject(new Error("the KeepDeck plugin has stopped"))
      : request({ path: socket.path, token, method, params, signal, open });

  const listOnce = async () => {
    try {
      const next = toolsOf(await ask("tools/list", {}));
      const as = JSON.stringify(next);
      report(`${next.length} commands offered as tools`);
      if (as === listedAs || stopped) return;
      tools = next;
      listedAs = as;
      await context.tool.reload();
    } catch (error) {
      // A listing the stop itself cut short is not news.
      if (!stopped) report(`the deck's commands could not be listed: ${messageOf(error)}`);
    }
  };

  /** One listing at a time, in order; a trigger that arrives meanwhile is
   * kept, not dropped. */
  const relist = async () => {
    if (stopped) return;
    if (listing) {
      again = true;
      return;
    }
    listing = true;
    try {
      do {
        again = false;
        await listOnce();
      } while (again && !stopped);
    } finally {
      listing = false;
    }
  };

  /** @param {string} name */
  const execute = (name) => async (/** @type {unknown} */ input, /** @type {CallContext} */ call) => {
    const args = isRecord(input) ? input : {};
    // A refusal propagates as it came, as opencode asks of a plugin: what it
    // makes of it is opencode's (packages/plugin/src/promise/permission.ts at
    // v2.4.1). Measured on 2.4.1: the model gets a Tool.Error and the turn
    // goes on.
    await context.permission.assert({
      sessionID: call.sessionID,
      ...(call.agent === undefined ? {} : { agent: call.agent }),
      action: `${NAMESPACE}_${name}`,
      resources: ["*"],
      save: ["*"],
      metadata: { input: args },
      source: { type: "tool", messageID: call.messageID, id: call.id },
    });
    return resultOf(await ask("tools/call", { name, arguments: args }, call.signal));
  };

  await context.tool.transform((editor) => {
    if (tools.length === 0) return;
    editor.namespace({ name: NAMESPACE, description: NAMESPACE_DESCRIPTION });
    for (const tool of tools) {
      editor.add({
        name: tool.name,
        options: { namespace: NAMESPACE },
        description: tool.description,
        input: tool.inputSchema,
        // No declared output, as an MCP tool without one: the model is told
        // the result's shape is unknown.
        output: {},
        execute: execute(tool.name),
      });
    }
  });
  void relist();

  return {
    /** @param {unknown} event */
    onEvent(event) {
      if (isRecord(event) && event.type === TURN_STARTED) void relist();
    },
    stop() {
      stopped = true;
      for (const connection of open) connection.destroy();
      open.clear();
    },
  };
}

/**
 * One request on a connection of its own: the greeting, the line, the one
 * line that answers it. No bound of its own: the deck answers within its own
 * patience, and the call's signal ends the wait sooner.
 * @param {{
 *   path: string,
 *   token: string | undefined,
 *   method: string,
 *   params: Record<string, unknown>,
 *   signal?: AbortSignal,
 *   open: Set<import("node:net").Socket>,
 * }} request
 * @returns {Promise<unknown>}
 */
function request({ path, token, method, params, signal, open }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("the call was interrupted"));
      return;
    }
    const connection = connect(path);
    open.add(connection);
    let buffer = "";
    let settled = false;
    /** @param {Error | undefined} error @param {unknown} [answer] */
    const settle = (error, answer) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      open.delete(connection);
      connection.destroy();
      if (error) reject(error);
      else resolve(answer);
    };
    const onAbort = () => settle(new Error("the call was interrupted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    connection.setEncoding("utf8");
    connection.on("connect", () => {
      if (token) connection.write(`${greetingLine(token)}\n`);
      connection.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
    });
    connection.on("data", (/** @type {string} */ chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        settle(undefined, JSON.parse(buffer.slice(0, end)));
      } catch {
        settle(new Error("the deck answered with something that is not JSON"));
      }
    });
    connection.on("error", (error) => settle(new Error(`the deck cannot be reached: ${error.message}`)));
    connection.on("close", () => settle(new Error("the deck closed the connection")));
  });
}

/** The commands a `tools/list` answer offers, each with what a tool needs.
 * @param {unknown} answer
 * @returns {DeckTool[]} */
function toolsOf(answer) {
  const result = rpcResult(answer);
  const listed = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
  return listed.flatMap((tool) =>
    isRecord(tool) && typeof tool.name === "string" && tool.name !== "" && isRecord(tool.inputSchema)
      ? [{ name: tool.name, description: typeof tool.description === "string" ? tool.description : "", inputSchema: tool.inputSchema }]
      : [],
  );
}

/** A `tools/call` answer as an opencode tool result: what opencode makes of
 * an MCP tool's result, so the model reads the same thing either way.
 * @param {unknown} answer */
function resultOf(answer) {
  const result = rpcResult(answer);
  const parts = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  const content = parts.flatMap((part) =>
    isRecord(part) && part.type === "text" && typeof part.text === "string" ? [{ type: "text", text: part.text }] : [],
  );
  const text = content.map((part) => part.text).join("\n");
  if (isRecord(result) && result.isError === true) {
    throw new Error(text.trim() || "the KeepDeck command failed");
  }
  return { output: outputOf(text), ...(content.length === 0 ? {} : { content }) };
}

/** The JSON-RPC result, or the error it answered with, thrown.
 * @param {unknown} answer */
function rpcResult(answer) {
  if (!isRecord(answer)) throw new Error("the deck's answer is not a JSON-RPC message");
  if (isRecord(answer.error)) {
    throw new Error(typeof answer.error.message === "string" ? answer.error.message : "the deck refused the request");
  }
  return answer.result;
}

/** A text result as opencode reads one from a server that declares no output
 * schema: JSON stays an object, anything else stays text, nothing is null.
 * @param {string} text */
function outputOf(text) {
  if (text === "") return null;
  if (!text.startsWith("{") && !text.startsWith("[")) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
