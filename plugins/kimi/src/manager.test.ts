import { describe, expect, it, vi } from "vitest";
import type {
  PluginSessionEvent,
  PluginSessionHandle,
  PluginSessions,
} from "@keepdeck/plugin-api";
import {
  createKimiCompanionManager,
  extractServerAccess,
} from "./manager";

const encoder = new TextEncoder();

function harness(
  output: string,
  responses: unknown[] = [{ code: 0, msg: "", data: null }],
) {
  const close = vi.fn(async () => {});
  const handle: PluginSessionHandle = {
    id: "kimi-setup",
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    close,
  };
  const spawn = vi.fn(
    async (_opts: unknown, onEvent: (event: PluginSessionEvent) => void) => {
      // The native backend may emit output before spawn() resolves its handle.
      onEvent({ type: "output", bytes: encoder.encode(output) });
      return handle;
    },
  );
  const queue = [...responses];
  const fetcher = vi.fn(async () => {
    const response = queue.shift();
    if (response === undefined) throw new Error("Unexpected Kimi API call");
    return {
      ok: true,
      status: 200,
      json: async () => response,
    };
  }) as unknown as typeof fetch;
  const manager = createKimiCompanionManager(
    { spawn } as unknown as PluginSessions,
    fetcher,
  );
  return { manager, spawn, fetcher, close };
}

describe("Kimi setup server access", () => {
  it("extracts an authenticated loopback URL through ANSI styling", () => {
    expect(
      extractServerAccess(
        "\u001b[32mKimi server:\u001b[0m http://127.0.0.1:43123/\u001b[90m#token=abc_123-XYZ\u001b[0m\r\n",
      ),
    ).toEqual({ origin: "http://127.0.0.1:43123", token: "abc_123-XYZ" });
  });

  it("rejects missing credentials and non-loopback URLs", () => {
    expect(extractServerAccess("http://127.0.0.1:4000/" )).toBeNull();
    expect(extractServerAccess("http://example.com:4000/#token=x")).toBeNull();
  });
});

describe("Kimi companion manager", () => {
  const ready = "Kimi server: http://127.0.0.1:43123/#token=secret-token\r\n";

  it("configures through the authenticated headless plugin API and stops the server", async () => {
    const { manager, spawn, fetcher, close } = harness(ready, [
      {
        code: 0,
        msg: "",
        data: {
          id: "keepdeck-session-reporter",
          version: "1.0.0",
          enabled: false,
          state: "ok",
        },
      },
      { code: 0, msg: "", data: null },
    ]);
    await manager.configure("/App/resources/keepdeck-session-reporter");

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kimi",
        args: expect.arrayContaining(["server", "run", "--foreground", "--port", "0"]),
      }),
      expect.any(Function),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/api/v2/pluginService/installPlugin",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer secret-token" }),
        body: JSON.stringify({ source: "/App/resources/keepdeck-session-reporter" }),
      }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/api/v2/pluginService/setPluginEnabled",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          id: "keepdeck-session-reporter",
          enabled: true,
        }),
      }),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("inspects the actual Kimi installation state", async () => {
    const { manager } = harness(ready, [
      {
        code: 0,
        msg: "",
        data: [
          {
            id: "keepdeck-session-reporter",
            version: "1.0.0",
            enabled: true,
            state: "ok",
          },
        ],
      },
    ]);
    await expect(manager.inspect("keepdeck-session-reporter")).resolves.toEqual({
      version: "1.0.0",
      enabled: true,
      healthy: true,
    });
  });

  it("reports an absent companion from Kimi's empty plugin list", async () => {
    const { manager } = harness(ready, [
      { code: 0, msg: "", data: [] },
    ]);
    await expect(manager.inspect("keepdeck-session-reporter")).resolves.toBeNull();
  });

  it("removes through the same one-operation server", async () => {
    const { manager, fetcher, close } = harness(ready, [
      { code: 0, msg: "", data: null },
    ]);
    await manager.remove("keepdeck-session-reporter");
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/api/v2/pluginService/removePlugin",
      expect.objectContaining({
        body: JSON.stringify({ id: "keepdeck-session-reporter" }),
      }),
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("surfaces Kimi's API error and still stops the server", async () => {
    const { manager, close } = harness(ready, [
      {
        code: 40412,
        msg: "plugin not found",
        data: null,
      },
    ]);
    await expect(manager.remove("missing")).rejects.toThrow("plugin not found");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
