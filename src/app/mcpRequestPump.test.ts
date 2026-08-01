import { describe, expect, it, vi } from "vitest";

vi.mock("../ipc/log", () => ({
  log: { warn: vi.fn() },
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { log } from "../ipc/log";
import type { McpRequest } from "../ipc/mcpBridge";
import { createMcpRequestPump, type McpPumpPorts } from "./mcpRequestPump";

function ports() {
  let deliver: ((request: McpRequest) => void) | null = null;
  const unlisten = vi.fn();
  const respond = vi.fn((_id: number, _reply: string) => Promise.resolve());
  const subscribed = Promise.resolve(unlisten);
  const pump: McpPumpPorts = {
    subscribe(handler) {
      deliver = handler;
      return subscribed;
    },
    respond,
  };
  return {
    pump,
    respond,
    unlisten,
    subscribed,
    request: (id: number, line: string) => deliver?.({ id, line }),
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createMcpRequestPump", () => {
  it("answers a request through the handler, keyed by the transport id", async () => {
    const p = ports();
    createMcpRequestPump((line) => line.toUpperCase(), p.pump);
    await flush();
    p.request(5, '{"a":1}');
    await flush();
    expect(p.respond).toHaveBeenCalledWith(5, '{"A":1}');
  });

  it("a throwing handler still answers, echoing the request's own id", async () => {
    const p = ports();
    createMcpRequestPump(() => {
      throw new Error("projection exploded");
    }, p.pump);
    await flush();
    p.request(8, '{"id":41,"method":"tools/call"}');
    await flush();
    expect(p.respond).toHaveBeenCalledTimes(1);
    const [transportId, reply] = p.respond.mock.calls[0];
    expect(transportId).toBe(8);
    const parsed = JSON.parse(reply);
    expect(parsed.id).toBe(41);
    expect(parsed.error.code).toBe(-32603);
    expect(parsed.error.message).toContain("projection exploded");
  });

  it("a null reply (notification) sends nothing back", async () => {
    const p = ports();
    createMcpRequestPump(() => null, p.pump);
    await flush();
    p.request(3, '{"method":"notifications/initialized"}');
    await flush();
    expect(p.respond).not.toHaveBeenCalled();
  });

  it("a failed delivery is logged, not thrown", async () => {
    const p = ports();
    p.respond.mockRejectedValueOnce(new Error("bridge gone"));
    createMcpRequestPump((line) => line, p.pump);
    await flush();
    p.request(1, "{}");
    await flush();
    expect(log.warn).toHaveBeenCalled();
  });

  it("dispose stops handling and releases the subscription", async () => {
    const p = ports();
    const pump = createMcpRequestPump((line) => line, p.pump);
    await flush();
    pump.dispose();
    expect(p.unlisten).toHaveBeenCalled();
    p.request(2, "{}");
    await flush();
    expect(p.respond).not.toHaveBeenCalled();
  });

  it("a failed subscription is logged, never an unhandled rejection", async () => {
    createMcpRequestPump((line) => line, {
      subscribe: () => Promise.reject(new Error("no tauri window")),
      respond: vi.fn((_id: number, _reply: string) => Promise.resolve()),
    });
    await flush();
    expect(log.warn).toHaveBeenCalledWith(
      "web:mcp",
      expect.stringContaining("no tauri window"),
    );
  });

  it("dispose before the subscription settles still releases it", async () => {
    let deliver: ((request: McpRequest) => void) | null = null;
    const unlisten = vi.fn();
    let settle!: (un: () => void) => void;
    const pump = createMcpRequestPump((line) => line, {
      subscribe(handler) {
        deliver = handler;
        return new Promise((resolve) => (settle = resolve));
      },
      respond: vi.fn(() => Promise.resolve()),
    });
    pump.dispose();
    settle(unlisten);
    await flush();
    expect(unlisten).toHaveBeenCalled();
    expect(deliver).not.toBeNull();
  });
});
