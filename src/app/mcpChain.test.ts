import { describe, expect, it, vi } from "vitest";

vi.mock("../ipc/log", () => ({
  log: { warn: vi.fn() },
  describeError: (e: unknown) => String(e),
}));
vi.mock("../ipc/app", () => ({
  fetchAppInfo: () =>
    Promise.resolve({ name: "KeepDeck", version: "1.0.0", updater: false }),
}));

import { createCommandRegistry } from "../domain/commands";
import type { McpRequest } from "../ipc/mcpBridge";
import { createMcpLineHandler } from "./mcpProjection";
import { createMcpRequestPump, type McpPumpPorts } from "./mcpRequestPump";

/**
 * The webview chain assembled exactly as runtime.ts wires it — pump feeding
 * the registry projection — against fake bridge ports. Each unit is tested
 * on its own; this pins that the seams actually compose: transport ids and
 * JSON-RPC ids travel independently, and notifications cross without a
 * reply.
 */
describe("mcp webview chain", () => {
  function chain() {
    const registry = createCommandRegistry();
    registry.register({
      id: "workspace.switch",
      title: "Switch to a workspace",
      args: [
        { name: "workspace", type: "string", required: true, description: "Name" },
      ],
      run: (args) => ({ switched: args.workspace }),
    });
    let deliver: ((request: McpRequest) => void) | null = null;
    const respond = vi.fn((_id: number, _reply: string) => Promise.resolve());
    const ports: McpPumpPorts = {
      subscribe(handler) {
        deliver = handler;
        return Promise.resolve(() => {});
      },
      respond,
    };
    createMcpRequestPump(createMcpLineHandler(registry), ports);
    return {
      registry,
      respond,
      request: (id: number, line: string) => deliver?.({ id, line }),
    };
  }

  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("serves a full session: initialize, initialized, list, call", async () => {
    const c = chain();
    await flush();

    c.request(1, '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
    c.request(2, '{"jsonrpc":"2.0","method":"notifications/initialized"}');
    c.request(3, '{"jsonrpc":"2.0","id":2,"method":"tools/list"}');
    c.request(
      4,
      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"workspace_switch","arguments":{"workspace":"api"}}}',
    );
    await flush();

    // Three replies for four lines: the notification crossed silently.
    expect(c.respond).toHaveBeenCalledTimes(3);
    const byTransport = new Map(
      c.respond.mock.calls.map(([id, reply]) => [id, JSON.parse(reply)]),
    );
    expect(byTransport.get(1)?.result.serverInfo.name).toBe("KeepDeck");
    expect(byTransport.get(3)?.result.tools[0].name).toBe("workspace_switch");
    const call = byTransport.get(4);
    expect(call?.id).toBe(3); // JSON-RPC id, not the transport's 4
    expect(JSON.parse(call?.result.content[0].text)).toEqual({ switched: "api" });

    // And the registry journaled the external caller.
    const journal = c.registry.journal();
    expect(journal[journal.length - 1]?.source).toEqual({
      kind: "external",
      client: "mcp",
    });
  });

  it("a validation failure crosses as invalid-params with the right ids", async () => {
    const c = chain();
    await flush();
    c.request(
      7,
      '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"workspace_switch","arguments":{"workspace":5}}}',
    );
    await flush();
    const [transportId, reply] = c.respond.mock.calls[0];
    expect(transportId).toBe(7);
    const parsed = JSON.parse(reply);
    expect(parsed.id).toBe(11);
    expect(parsed.error.code).toBe(-32602);
    expect(parsed.error.message).toContain("workspace");
  });
});
