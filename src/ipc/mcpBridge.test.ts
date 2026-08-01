import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { MCP_REQUEST_EVENT, onMcpRequest, respondMcp } from "./mcpBridge";

/** Pins the wire contract to what the Rust side emits and registers. */
describe("mcpBridge ipc", () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
  });

  it("subscribes to deck://mcp/request and unwraps the payload", async () => {
    const un = vi.fn();
    listen.mockResolvedValueOnce(un);
    const handler = vi.fn();
    await onMcpRequest(handler);
    expect(listen).toHaveBeenCalledWith(MCP_REQUEST_EVENT, expect.any(Function));
    expect(MCP_REQUEST_EVENT).toBe("deck://mcp/request");
    const wrapped = listen.mock.calls[0][1] as (e: { payload: unknown }) => void;
    wrapped({ payload: { id: 4, line: "{}" } });
    expect(handler).toHaveBeenCalledWith({ id: 4, line: "{}" });
  });

  it("respondMcp invokes mcp_respond with id and reply", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await respondMcp(9, '{"jsonrpc":"2.0"}');
    expect(invoke).toHaveBeenCalledWith("mcp_respond", {
      id: 9,
      reply: '{"jsonrpc":"2.0"}',
    });
  });
});
