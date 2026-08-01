import { describe, expect, it, vi } from "vitest";

vi.mock("../ipc/log", () => ({
  log: { warn: vi.fn() },
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { createCommandRegistry, type CommandSource } from "../domain/commands";
import type { McpRequest } from "../ipc/mcpBridge";
import { createMcpService, type McpServiceDeps } from "./mcpService";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(opts: { initial?: boolean | null } = {}) {
  let value = opts.initial ?? null;
  const listeners = new Set<() => void>();
  const settings = {
    mcpServer: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const set = (next: boolean | null) => {
    value = next;
    for (const listener of [...listeners]) listener();
  };

  const order: string[] = [];
  let deliver: ((request: McpRequest) => void) | null = null;
  const respond = vi.fn((_id: number, _reply: string) => Promise.resolve());
  const pumpPorts = {
    subscribe(handler: (request: McpRequest) => void) {
      order.push("pump-subscribe");
      deliver = handler;
      return Promise.resolve(() => {});
    },
    respond,
  };
  const enable = vi.fn(() => {
    order.push("enable");
    return Promise.resolve("/home/mcp.sock");
  });
  const disable = vi.fn(() => Promise.resolve());
  const registry = createCommandRegistry();
  const deps: McpServiceDeps = {
    registry,
    transport: { enable, disable },
    pumpPorts,
    identitySource: () =>
      Promise.resolve({ name: "KeepDeck", version: "9.9.9" }),
  };
  return {
    settings,
    set,
    deps,
    registry,
    order,
    enable,
    disable,
    respond,
    request: (id: number, line: string) => deliver?.({ id, line }),
  };
}

describe("createMcpService", () => {
  it("subscribes the pump before the policy can enable the socket", async () => {
    const h = harness({ initial: true });
    createMcpService(h.settings, h.deps);
    await flush();
    expect(h.order[0]).toBe("pump-subscribe");
    expect(h.order).toContain("enable");
  });

  it("status reflects what the backend CONFIRMED, not the setting", async () => {
    const h = harness();
    const service = createMcpService(h.settings, h.deps);
    expect(service.status()).toEqual({ socket: null, error: null });

    const seen: string[] = [];
    service.subscribe(() => seen.push(service.status().socket ?? "-"));
    h.set(true);
    await flush();
    expect(service.status()).toEqual({ socket: "/home/mcp.sock", error: null });
    h.set(false);
    await flush();
    expect(service.status()).toEqual({ socket: null, error: null });
    expect(seen).toEqual(["/home/mcp.sock", "-"]);
  });

  it("a refused enable lands in status.error — the UI's signal", async () => {
    const h = harness();
    h.enable.mockRejectedValueOnce(new Error("already served by another process"));
    const service = createMcpService(h.settings, h.deps);
    h.set(true);
    await flush();
    expect(service.status().socket).toBeNull();
    expect(service.status().error).toContain("already served");
  });

  it("serves registry commands as the external mcp source, journaled", async () => {
    const h = harness();
    let seen: CommandSource | null = null;
    h.registry.register({
      id: "workspace.list",
      title: "List workspaces",
      args: [],
      run: (_args, source) => {
        seen = source;
        return [];
      },
    });
    createMcpService(h.settings, h.deps);
    await flush();
    h.request(
      1,
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"workspace_list"}}',
    );
    await flush();
    expect(seen).toEqual({ kind: "external", client: "mcp" });
    const journal = h.registry.journal();
    expect(journal[journal.length - 1]?.source).toEqual({
      kind: "external",
      client: "mcp",
    });
  });

  it("serves the fetched identity once it lands", async () => {
    const h = harness();
    createMcpService(h.settings, h.deps);
    await flush();
    h.request(2, '{"jsonrpc":"2.0","id":5,"method":"initialize","params":{}}');
    await flush();
    const [, reply] = h.respond.mock.calls[0];
    expect(JSON.parse(reply).result.serverInfo).toEqual({
      name: "KeepDeck",
      version: "9.9.9",
    });
  });

  it("dispose tears the socket down best-effort — a reload must not leave it serving unanswered", async () => {
    const h = harness();
    const service = createMcpService(h.settings, h.deps);
    await flush();
    service.dispose();
    expect(h.disable).toHaveBeenCalled();
  });
});
