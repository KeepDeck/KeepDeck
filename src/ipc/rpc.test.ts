import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (): Promise<unknown> => ({ result: "{}", sentAt: 123 })),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

import { pluginRpcRequest, pluginRpcStop } from "./rpc";

describe("the plugin rpc wire contract", () => {
  beforeEach(() => tauri.invoke.mockClear());

  it("sends the declared server whole, with absent fields as null", async () => {
    const answer = await pluginRpcRequest(
      "dev.example",
      { id: "server", command: "tool", args: ["serve"], methods: ["read"] },
      "read",
      undefined,
    );

    expect(answer).toEqual({ result: "{}", sentAt: 123 });
    expect(tauri.invoke).toHaveBeenCalledWith("plugin_rpc_request", {
      pluginId: "dev.example",
      server: { id: "server", command: "tool", args: ["serve"], handshake: null, methods: ["read"] },
      method: "read",
      params: null,
    });
  });

  it("carries the handshake and the params as given", async () => {
    const handshake = { method: "initialize", params: { client: "keepdeck" }, then: "initialized" };
    await pluginRpcRequest(
      "dev.example",
      { id: "server", command: "tool", args: [], handshake, methods: ["read"] },
      "read",
      { window: 7 },
    );

    expect(tauri.invoke).toHaveBeenCalledWith(
      "plugin_rpc_request",
      expect.objectContaining({
        server: expect.objectContaining({ handshake }),
        params: { window: 7 },
      }),
    );
  });

  it("stops a plugin's children by its id", async () => {
    await pluginRpcStop("dev.example");
    expect(tauri.invoke).toHaveBeenCalledWith("plugin_rpc_stop", { pluginId: "dev.example" });
  });
});
