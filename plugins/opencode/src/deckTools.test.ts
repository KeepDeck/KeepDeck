import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isJsonRecord } from "@keepdeck/plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeDeckSocket,
  DECK_SOCKET_ENV,
  encodeDeckSocket,
  greetingLine,
} from "../resources/keepdeck-plugin/deck-socket.js";
import { NAMESPACE, startDeckTools } from "../resources/keepdeck-plugin/deck-tools.js";

/**
 * KeepDeck's commands as opencode 2.x tools, against a stand-in of the deck's
 * MCP socket on a real unix socket and a stand-in of the 2.x `tool` and
 * `permission` domains (packages/plugin/src/promise at v2.4.1).
 */

type Rpc = Record<string, unknown>;
/** What the stand-in answers a request with: a JSON-RPC body, or nothing,
 * for a deck that never answers. */
type Answer = { result?: unknown; error?: unknown } | undefined;

interface Connection {
  lines: string[];
  closed: boolean;
  socket: Socket;
}

/** The deck's socket: every connection, every line it got, and an answer per
 * request chosen by the test. */
async function standInDeck(path: string) {
  const connections: Connection[] = [];
  let answer: (request: Rpc) => Answer | Promise<Answer> = () => undefined;
  const server: Server = createServer((socket) => {
    const connection: Connection = { lines: [], closed: false, socket };
    connections.push(connection);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        connection.lines.push(line);
        const request: unknown = JSON.parse(line);
        if (!isJsonRecord(request) || !("id" in request)) continue;
        void Promise.resolve(answer(request)).then((body) => {
          if (body !== undefined && !socket.destroyed) socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body })}\n`);
        });
      }
    });
    socket.on("close", () => (connection.closed = true));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    connections,
    /** The connection opened last. */
    latest(): Connection | undefined {
      return connections[connections.length - 1];
    },
    answer(next: typeof answer) {
      answer = next;
    },
    /** Requests by method, across every connection. */
    requests(method: string): Rpc[] {
      return connections.flatMap((connection) =>
        connection.lines.flatMap((line) => {
          const request: unknown = JSON.parse(line);
          return isJsonRecord(request) && request.method === method ? [request] : [];
        }),
      );
    },
    async close() {
      for (const connection of connections) connection.socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A tool as the component hands it to the registry's editor. */
interface Registered {
  name: string;
  description: string;
  input: unknown;
  output: unknown;
  options: unknown;
  execute: (input: unknown, call: Record<string, unknown>) => Promise<unknown>;
}
type Edited = { namespaces: { name: string; description: string }[]; tools: Registered[] };
type Editor = { namespace: (namespace: Edited["namespaces"][number]) => void; add: (tool: Registered) => void };

/** The 2.x domains this component touches. `registered()` replays the
 * transform the way the registry does on a read after a reload. */
function standInHost() {
  let edit: ((editor: Editor) => void) | undefined;
  const reload = vi.fn(async () => {});
  const assert = vi.fn(async (_input: Record<string, unknown>) => {});
  return {
    context: {
      tool: {
        transform: async (next: typeof edit) => {
          edit = next;
        },
        reload,
      },
      permission: { assert },
    },
    reload,
    assert,
    registered(): Edited {
      const edited: Edited = { namespaces: [], tools: [] };
      edit?.({ namespace: (n) => edited.namespaces.push(n), add: (t) => edited.tools.push(t) });
      return edited;
    },
    tool(name: string) {
      const tool = this.registered().tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`no tool ${name}`);
      return tool.execute;
    },
  };
}

const MAIL_SEND = {
  name: "mail_send",
  description: "Send a message to another agent",
  inputSchema: {
    type: "object",
    properties: { to: { type: "string" }, kind: { type: "string", enum: ["task", "note"] } },
    required: ["to"],
  },
};
const TASK_LIST = { name: "task_list", description: "List tasks", inputSchema: { type: "object", properties: {} } };

const listing = (...tools: unknown[]): Answer => ({ result: { tools } });
const text = (value: string, isError = false): Answer => ({ result: { content: [{ type: "text", text: value }], isError } });

/** Time for what is in flight on the socket to land: a connection accepted,
 * a request read. Used where a test asserts that something did NOT happen. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const call = (overrides: Record<string, unknown> = {}) => ({
  sessionID: "ses_1",
  agent: "build",
  messageID: "msg_1",
  id: "call_1",
  ...overrides,
});

let dir: string;
let path: string;
let deck: Awaited<ReturnType<typeof standInDeck>>;
let stops: (() => void)[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "kd-deck-"));
  path = join(dir, "mcp.sock");
  deck = await standInDeck(path);
  stops = [];
  vi.stubEnv(DECK_SOCKET_ENV, encodeDeckSocket({ path, client: "pane-secret" }));
  vi.stubEnv("KEEPDECK_BRIDGE", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const stop of stops) stop();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await deck.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Start the component; its stop runs after the test. */
async function start(host: ReturnType<typeof standInHost>) {
  const started = (await startDeckTools({ context: host.context })) as { stop?: () => void; onEvent?: (event: unknown) => void };
  if (started.stop) stops.push(started.stop);
  return started;
}

/** Start, and wait until the first listing has landed. */
async function listed(host: ReturnType<typeof standInHost>) {
  const started = await start(host);
  await vi.waitFor(() => expect(host.reload).toHaveBeenCalled());
  return started;
}

describe("the deck's commands as opencode 2.x tools", () => {
  it("does nothing in a pane the launch did not hand the socket", async () => {
    vi.stubEnv(DECK_SOCKET_ENV, "");
    const host = standInHost();

    expect(await startDeckTools({ context: host.context })).toEqual({});
    expect(host.registered().tools).toEqual([]);
    expect(deck.connections).toEqual([]);
  });

  it("does nothing on a host without the tool and permission domains", async () => {
    expect(await startDeckTools({ context: { tool: {} } })).toEqual({});
    expect(deck.connections).toEqual([]);
  });

  it("returns at once while the deck stays silent", async () => {
    // A pending setup leaves the TUI taking prompts on opencode's default
    // model (measured on 2.4.1): the component must never hold setup up.
    deck.answer(() => undefined);
    const host = standInHost();

    await start(host);

    await vi.waitFor(() => expect(deck.requests("tools/list")).toHaveLength(1));
    expect(host.registered().tools).toEqual([]);
    expect(host.reload).not.toHaveBeenCalled();
  });

  it("greets with the pane's secret before it asks anything", async () => {
    deck.answer(() => listing(MAIL_SEND));
    await listed(standInHost());

    const [first] = deck.connections;
    expect(first?.lines[0]).toBe(greetingLine("pane-secret"));
    expect(JSON.parse(first?.lines[1] ?? "{}")).toMatchObject({ method: "tools/list" });
  });

  it("greets with the bridge's secret when the launch named none, as the shim does", async () => {
    vi.stubEnv(DECK_SOCKET_ENV, encodeDeckSocket({ path }));
    vi.stubEnv("KEEPDECK_BRIDGE", JSON.stringify({ dir, pane: "pane-1", token: "bridge-secret", socket: "/nonexistent/s" }));
    deck.answer(() => listing(MAIL_SEND));
    await listed(standInHost());

    expect(deck.connections[0]?.lines[0]).toBe(greetingLine("bridge-secret"));
  });

  it("offers every listed command under the keepdeck namespace, its schema whole", async () => {
    deck.answer(() => listing(MAIL_SEND, TASK_LIST, { name: "", inputSchema: {} }, { name: "no_schema" }));
    const host = standInHost();
    await listed(host);

    const { namespaces, tools } = host.registered();
    expect(namespaces.map((n) => n.name)).toEqual([NAMESPACE]);
    expect(tools.map(({ name, description, input, output, options }) => ({ name, description, input, output, options }))).toEqual([
      { name: "mail_send", description: MAIL_SEND.description, input: MAIL_SEND.inputSchema, output: {}, options: { namespace: NAMESPACE } },
      { name: "task_list", description: TASK_LIST.description, input: TASK_LIST.inputSchema, output: {}, options: { namespace: NAMESPACE } },
    ]);
  });

  it("asks permission as opencode does for an MCP tool, before any connection for the call", async () => {
    deck.answer((request) => (request.method === "tools/list" ? listing(MAIL_SEND) : text('{"id":"mail-1"}')));
    const host = standInHost();
    await listed(host);
    const before = deck.connections.length;
    let grant: (() => void) | undefined;
    host.assert.mockImplementation(() => new Promise<void>((resolve) => (grant = resolve)));

    const pending = host.tool("mail_send")({ to: "lead" }, call());
    await vi.waitFor(() => expect(host.assert).toHaveBeenCalled());
    // Long enough for a connection opened before the answer to be accepted.
    await settle();
    expect(deck.connections).toHaveLength(before);
    grant?.();
    await pending;
    expect(deck.connections).toHaveLength(before + 1);

    expect(host.assert).toHaveBeenCalledWith({
      sessionID: "ses_1",
      agent: "build",
      action: "keepdeck_mail_send",
      resources: ["*"],
      save: ["*"],
      metadata: { input: { to: "lead" } },
      source: { type: "tool", messageID: "msg_1", id: "call_1" },
    });
  });

  it("opens no connection when the permission is refused, and fails the call", async () => {
    deck.answer(() => listing(MAIL_SEND));
    const host = standInHost();
    await listed(host);
    const before = deck.connections.length;
    host.assert.mockRejectedValue(new Error("rejected by the user"));

    await expect(host.tool("mail_send")({ to: "lead" }, call())).rejects.toThrow("rejected by the user");
    await settle();
    expect(deck.connections).toHaveLength(before);
  });

  it("sends the call on a connection of its own and reads its result as opencode reads an MCP one", async () => {
    deck.answer((request) => (request.method === "tools/list" ? listing(MAIL_SEND) : text('{\n  "id": "mail-1"\n}')));
    const host = standInHost();
    await listed(host);

    const result = await host.tool("mail_send")({ to: "lead", kind: "note" }, call());

    const callConnection = deck.latest();
    expect(callConnection?.lines[0]).toBe(greetingLine("pane-secret"));
    expect(JSON.parse(callConnection?.lines[1] ?? "{}")).toMatchObject({
      method: "tools/call",
      params: { name: "mail_send", arguments: { to: "lead", kind: "note" } },
    });
    expect(result).toEqual({ output: { id: "mail-1" }, content: [{ type: "text", text: '{\n  "id": "mail-1"\n}' }] });
    await vi.waitFor(() => expect(callConnection?.closed).toBe(true));
  });

  it("fails a call the deck answered with isError, or with a JSON-RPC error", async () => {
    let next: Answer = text("the pane is gone", true);
    deck.answer((request) => (request.method === "tools/list" ? listing(MAIL_SEND) : next));
    const host = standInHost();
    await listed(host);

    await expect(host.tool("mail_send")({}, call())).rejects.toThrow("the pane is gone");
    next = { error: { code: -32602, message: 'unknown tool "mail_send"' } };
    await expect(host.tool("mail_send")({}, call())).rejects.toThrow('unknown tool "mail_send"');
  });

  it("runs two calls at once on two connections", async () => {
    const waiting: (() => void)[] = [];
    deck.answer((request) =>
      request.method === "tools/list"
        ? listing(MAIL_SEND)
        : new Promise<Answer>((resolve) => waiting.push(() => resolve(text("ok")))),
    );
    const host = standInHost();
    await listed(host);

    const both = Promise.all([
      host.tool("mail_send")({ to: "a" }, call({ id: "call_1" })),
      host.tool("mail_send")({ to: "b" }, call({ id: "call_2" })),
    ]);
    // Both reached the deck before either was answered.
    await vi.waitFor(() => expect(deck.requests("tools/call")).toHaveLength(2));
    for (const answer of waiting) answer();
    await both;
  });

  it("closes the call's connection when the call is interrupted", async () => {
    deck.answer((request) => (request.method === "tools/list" ? listing(MAIL_SEND) : undefined));
    const host = standInHost();
    await listed(host);
    const abort = new AbortController();

    const pending = host.tool("mail_send")({}, call({ signal: abort.signal }));
    await vi.waitFor(() => expect(deck.requests("tools/call")).toHaveLength(1));
    abort.abort();

    await expect(pending).rejects.toThrow("interrupted");
    await vi.waitFor(() => expect(deck.latest()?.closed).toBe(true));
  });

  it("fails a call while the deck is gone, and reaches it again once it is back", async () => {
    deck.answer((request) => (request.method === "tools/list" ? listing(MAIL_SEND) : text("ok")));
    const host = standInHost();
    await listed(host);

    await deck.close();
    await expect(host.tool("mail_send")({}, call())).rejects.toThrow("the deck cannot be reached");

    deck = await standInDeck(path);
    deck.answer(() => text("ok"));
    await expect(host.tool("mail_send")({}, call())).resolves.toMatchObject({ output: "ok" });
  });

  it("lists again as a turn starts, and reloads only when the list changed", async () => {
    let offered: unknown[] = [MAIL_SEND];
    deck.answer(() => listing(...offered));
    const host = standInHost();
    const started = await listed(host);
    expect(host.reload).toHaveBeenCalledTimes(1);

    started.onEvent?.({ type: "session.execution.started", data: { sessionID: "ses_1" } });
    await vi.waitFor(() => expect(deck.requests("tools/list")).toHaveLength(2));
    // Nothing new: the tools stand as they were.
    await settle();
    expect(host.reload).toHaveBeenCalledTimes(1);

    offered = [MAIL_SEND, TASK_LIST];
    started.onEvent?.({ type: "session.execution.started", data: { sessionID: "ses_1" } });
    await vi.waitFor(() => expect(host.reload).toHaveBeenCalledTimes(2));
    expect(host.registered().tools.map((tool) => tool.name)).toEqual(["mail_send", "task_list"]);

    // Any other event is not a turn.
    started.onEvent?.({ type: "session.step.started", data: {} });
    await settle();
    expect(deck.requests("tools/list")).toHaveLength(3);
  });

  it("keeps a turn that starts while a listing is on its way, and lists again after it", async () => {
    let offered: unknown[] = [MAIL_SEND];
    let held: (() => void) | undefined;
    let hold = false;
    deck.answer(() => {
      // The answer is what the deck held when it was asked.
      const body = listing(...offered);
      return hold ? new Promise<Answer>((resolve) => (held = () => resolve(body))) : body;
    });
    const host = standInHost();
    const started = await listed(host);

    hold = true;
    started.onEvent?.({ type: "session.execution.started", data: {} });
    await vi.waitFor(() => expect(held).toBeDefined());
    // A command lands, and the next turn starts, while that listing waits.
    offered = [MAIL_SEND, TASK_LIST];
    hold = false;
    started.onEvent?.({ type: "session.execution.started", data: {} });
    held?.();

    await vi.waitFor(() => expect(host.registered().tools.map((tool) => tool.name)).toEqual(["mail_send", "task_list"]));
    expect(deck.requests("tools/list")).toHaveLength(3);
  });

  it("sends nothing once the plugin stopped, a call whose permission was still pending included", async () => {
    deck.answer((request) => (request.method === "tools/list" ? listing(MAIL_SEND) : text("ok")));
    const host = standInHost();
    const started = await listed(host);
    const before = deck.connections.length;
    let grant: (() => void) | undefined;
    host.assert.mockImplementation(() => new Promise<void>((resolve) => (grant = resolve)));

    const pending = host.tool("mail_send")({}, call());
    await vi.waitFor(() => expect(host.assert).toHaveBeenCalled());
    started.stop?.();
    grant?.();

    await expect(pending).rejects.toThrow("stopped");
    await settle();
    expect(deck.connections).toHaveLength(before);
    // Nor does a turn list again.
    started.onEvent?.({ type: "session.execution.started", data: {} });
    await settle();
    expect(deck.requests("tools/list")).toHaveLength(1);
  });

  it("says once when the listing changes state, and not on every turn", async () => {
    let up = false;
    deck.answer(() => (up ? listing(MAIL_SEND) : { error: { code: -32603, message: "the deck did not answer" } }));
    const host = standInHost();
    const started = await start(host);
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledTimes(1));
    expect(console.error).toHaveBeenLastCalledWith("keepdeck: the deck's commands could not be listed: the deck did not answer");

    started.onEvent?.({ type: "session.execution.started", data: {} });
    await vi.waitFor(() => expect(deck.requests("tools/list")).toHaveLength(2));
    await settle();
    expect(console.error).toHaveBeenCalledTimes(1);

    up = true;
    started.onEvent?.({ type: "session.execution.started", data: {} });
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledTimes(2));
    expect(console.error).toHaveBeenLastCalledWith("keepdeck: 1 commands offered as tools");
  });

  it("closes what is open when the plugin stops", async () => {
    deck.answer((request) => (request.method === "tools/list" ? listing(MAIL_SEND) : undefined));
    const host = standInHost();
    const started = await listed(host);
    const pending = host.tool("mail_send")({}, call());
    await vi.waitFor(() => expect(deck.requests("tools/call")).toHaveLength(1));

    started.stop?.();

    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(deck.latest()?.closed).toBe(true));
  });
});

describe("the variable a 2.x launch writes", () => {
  it("reads back what the launch wrote", () => {
    for (const socket of [{ path: "/k/mcp.sock", client: "s" }, { path: "/k/mcp.sock" }]) {
      expect(decodeDeckSocket(encodeDeckSocket(socket))).toEqual(socket);
    }
  });

  it("says nothing for a value no launch wrote", () => {
    for (const raw of [undefined, "", "not json", "[]", "null", '{"client":"s"}', '{"path":""}', '{"path":"/k","client":7}', '{"path":"/k","client":""}']) {
      expect(decodeDeckSocket(raw)).toBeUndefined();
    }
  });

  it("greets with the line the shim writes, byte for byte", () => {
    // The Rust shim and the socket's reader are held to the same file
    // (shim.rs, bridge.rs).
    const shared: unknown = JSON.parse(
      readFileSync(new URL("../../../src-tauri/src/mcp/client-greeting.json", import.meta.url), "utf8"),
    );
    if (!isJsonRecord(shared) || typeof shared.token !== "string") throw new Error("the shared greeting has no token");
    expect(greetingLine(shared.token)).toBe(shared.line);
  });
});
