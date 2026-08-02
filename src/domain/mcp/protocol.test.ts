import { describe, expect, it, vi } from "vitest";
import type { CommandInfo, CommandResult } from "../commands";
import {
  MCP_PROTOCOL_VERSION,
  handleMcpLine,
  toolNameOf,
  type McpCommandPort,
} from "./protocol";

const IDENTITY = () => ({ name: "KeepDeck", version: "1.2.3" });

const SPAWN: CommandInfo = {
  id: "agent.spawn",
  title: "Spawn an agent in a workspace",
  args: [
    { name: "workspace", type: "string", required: true, description: "Target" },
    { name: "task", type: "string", description: "Initial prompt" },
  ],
  destructive: false,
};
const CLOSE: CommandInfo = {
  id: "agent.close",
  title: "Close an agent pane",
  args: [],
  destructive: true,
};

function port(
  overrides: Partial<McpCommandPort> = {},
): McpCommandPort & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(
    (): Promise<CommandResult> => Promise.resolve({ ok: true, value: { paneId: "p1" } }),
  );
  return { list: () => [SPAWN, CLOSE], execute, ...overrides } as McpCommandPort & {
    execute: ReturnType<typeof vi.fn>;
  };
}

const request = (id: number, method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

const parse = async (reply: Promise<string | null>) =>
  JSON.parse((await reply) ?? "null");

describe("handleMcpLine — session plumbing", () => {
  it("initialize reports identity and echoes a supported revision", async () => {
    const reply = await parse(
      handleMcpLine(port(), IDENTITY, request(1, "initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
      })),
    );
    expect(reply.id).toBe(1);
    expect(reply.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(reply.result.serverInfo).toEqual({ name: "KeepDeck", version: "1.2.3" });
    expect(reply.result.capabilities.tools).toEqual({ listChanged: false });
  });

  it("initialize never claims a revision the projection does not implement", async () => {
    // Spec MUST: echo the requested version only if supported, else answer
    // with one the server supports. 2025-03-26 requires batching this
    // projection refuses, so claiming it would be a lie.
    const requested = await parse(
      handleMcpLine(port(), IDENTITY, request(1, "initialize", {
        protocolVersion: "2025-03-26",
      })),
    );
    expect(requested.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    const omitted = await parse(handleMcpLine(port(), IDENTITY, request(1, "initialize")));
    expect(omitted.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it("notifications are consumed silently, known or not", async () => {
    const initialized = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    await expect(handleMcpLine(port(), IDENTITY, initialized)).resolves.toBeNull();
    const unknown = JSON.stringify({ jsonrpc: "2.0", method: "notifications/whatever" });
    await expect(handleMcpLine(port(), IDENTITY, unknown)).resolves.toBeNull();
  });

  it("ping pongs", async () => {
    const reply = await parse(handleMcpLine(port(), IDENTITY, request(2, "ping")));
    expect(reply.result).toEqual({});
  });

  it("garbage is answered as a failed request, not silence", async () => {
    const reply = await parse(handleMcpLine(port(), IDENTITY, "not json"));
    expect(reply.id).toBeNull();
    expect(reply.error.code).toBe(-32700);
  });

  it("an unknown method with an id gets method-not-found", async () => {
    const reply = await parse(handleMcpLine(port(), IDENTITY, request(3, "resources/list")));
    expect(reply.error.code).toBe(-32601);
  });
});

describe("handleMcpLine — tools", () => {
  it("tools/list projects dot ids to underscore names with schemas", async () => {
    const reply = await parse(handleMcpLine(port(), IDENTITY, request(4, "tools/list")));
    const [spawn, close] = reply.result.tools;
    expect(spawn.name).toBe("agent_spawn");
    expect(spawn.description).toBe(SPAWN.title);
    expect(spawn.inputSchema).toEqual({
      type: "object",
      properties: {
        workspace: { type: "string", description: "Target" },
        task: { type: "string", description: "Initial prompt" },
      },
      required: ["workspace"],
    });
    expect(spawn.annotations).toEqual({ destructiveHint: false });
    expect(close.annotations).toEqual({ destructiveHint: true });
    // No required args → no required key at all (an empty array is noise).
    expect(close.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("tools/call executes the projected command and returns its value", async () => {
    const p = port();
    const reply = await parse(
      handleMcpLine(p, IDENTITY, request(5, "tools/call", {
        name: "agent_spawn",
        arguments: { workspace: "api" },
      })),
    );
    expect(p.execute).toHaveBeenCalledWith("agent.spawn", { workspace: "api" }, null);
    expect(reply.result.isError).toBe(false);
    expect(JSON.parse(reply.result.content[0].text)).toEqual({ paneId: "p1" });
  });

  it("a command that ran and failed is a tool result, not a protocol error", async () => {
    const p = port();
    p.execute.mockResolvedValueOnce({
      ok: false,
      error: { code: "failed", message: "no active workspace" },
    });
    const reply = await parse(
      handleMcpLine(p, IDENTITY, request(6, "tools/call", { name: "agent_spawn" })),
    );
    expect(reply.error).toBeUndefined();
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toBe("no active workspace");
  });

  it("argument problems surface as invalid-params protocol errors", async () => {
    const p = port();
    p.execute.mockResolvedValueOnce({
      ok: false,
      error: { code: "invalid-args", message: 'missing required argument "workspace"' },
    });
    const reply = await parse(
      handleMcpLine(p, IDENTITY, request(7, "tools/call", { name: "agent_spawn" })),
    );
    expect(reply.error.code).toBe(-32602);
    expect(reply.error.message).toContain("workspace");
  });

  it("an unknown tool is refused without touching the registry", async () => {
    const p = port();
    const reply = await parse(
      handleMcpLine(p, IDENTITY, request(8, "tools/call", { name: "no_such" })),
    );
    expect(reply.error.code).toBe(-32602);
    expect(p.execute).not.toHaveBeenCalled();
  });

  it("a throwing port is an internal error, not silence", async () => {
    const p = port();
    p.execute.mockImplementationOnce(() => {
      throw new Error("port exploded");
    });
    const reply = await parse(
      handleMcpLine(p, IDENTITY, request(10, "tools/call", { name: "agent_spawn" })),
    );
    expect(reply.id).toBe(10);
    expect(reply.error.code).toBe(-32603);
    expect(reply.error.message).toContain("port exploded");
  });

  it("every wire reply is one line — the framing is newline-delimited", async () => {
    // The tool result's text is PRETTY-printed JSON (embedded newlines);
    // the envelope serialization must escape them. Guards the framing
    // against a refactor that builds the reply by concatenation.
    const raw = await handleMcpLine(
      port(),
      IDENTITY,
      request(11, "tools/call", { name: "agent_spawn" }),
    );
    expect(raw).not.toContain("\n");
  });

  it("non-object arguments are refused before execution", async () => {
    const p = port();
    const reply = await parse(
      handleMcpLine(p, IDENTITY, request(9, "tools/call", {
        name: "agent_spawn",
        arguments: [1, 2],
      })),
    );
    expect(reply.error.code).toBe(-32602);
    expect(p.execute).not.toHaveBeenCalled();
  });
});

describe("toolNameOf", () => {
  it("flattens every namespace dot", () => {
    expect(toolNameOf("keepdeck.run.launch")).toBe("keepdeck_run_launch");
  });
});
