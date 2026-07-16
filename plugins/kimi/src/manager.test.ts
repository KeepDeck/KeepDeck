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
import {
  COMPANION_DESCRIPTOR,
  COMPANION_ID,
  COMPANION_VERSION,
} from "./companion";

const encoder = new TextEncoder();
const SOURCE_DIRECTORY = "/App/resources/keepdeck-session-reporter";

function pluginSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: COMPANION_ID,
    displayName: COMPANION_DESCRIPTOR.displayName,
    version: COMPANION_VERSION,
    enabled: true,
    state: "ok",
    hasErrors: false,
    source: "local-path",
    originalSource: SOURCE_DIRECTORY,
    skillCount: 0,
    mcpServerCount: 0,
    hookCount: COMPANION_DESCRIPTOR.hookCount,
    commandCount: 0,
    ...overrides,
  };
}

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
  const fetcher = vi.fn(async (input: string) => {
    const response = queue.shift();
    if (response === undefined) throw new Error("Unexpected Kimi API call");
    return {
      ok: true,
      status: 200,
      url: input,
      json: async () => response,
    };
  }) as unknown as typeof fetch;
  const manager = createKimiCompanionManager(
    { spawn } as unknown as PluginSessions,
    COMPANION_DESCRIPTOR,
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
    expect(
      extractServerAccess("http://localhost:4000/#token=x"),
    ).toBeNull();
    expect(extractServerAccess("http://[::1]:4000/#token=x")).toBeNull();
    expect(extractServerAccess("http://example.com:4000/#token=x")).toBeNull();
  });
});

describe("Kimi companion manager", () => {
  const ready = "Kimi server: http://127.0.0.1:43123/#token=secret-token\r\n";

  it("configures through the authenticated headless plugin API and stops the server", async () => {
    const { manager, spawn, fetcher, close } = harness(ready, [
      { code: 0, msg: "", data: [] },
      {
        code: 0,
        msg: "",
        data: pluginSummary({ enabled: false }),
      },
      { code: 0, msg: "", data: null },
    ]);
    await manager.configure(SOURCE_DIRECTORY);

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
        body: JSON.stringify({ source: SOURCE_DIRECTORY }),
        redirect: "error",
      }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/api/v2/pluginService/setPluginEnabled",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          id: COMPANION_ID,
          enabled: true,
        }),
      }),
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("inspects the actual Kimi installation state", async () => {
    const { manager } = harness(ready, [
      {
        code: 0,
        msg: "",
        data: [
          pluginSummary(),
        ],
      },
    ]);
    await expect(manager.inspect()).resolves.toEqual({
      version: COMPANION_VERSION,
      enabled: true,
      healthy: true,
      owned: true,
    });
  });

  it("reports an absent companion from Kimi's empty plugin list", async () => {
    const { manager } = harness(ready, [
      { code: 0, msg: "", data: [] },
    ]);
    await expect(manager.inspect()).resolves.toBeNull();
  });

  it("removes through the same one-operation server", async () => {
    const { manager, fetcher, close } = harness(ready, [
      { code: 0, msg: "", data: [pluginSummary()] },
      { code: 0, msg: "", data: null },
    ]);
    await manager.remove();
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/api/v2/pluginService/removePlugin",
      expect.objectContaining({
        body: JSON.stringify({ id: COMPANION_ID }),
      }),
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("surfaces Kimi's API error and still stops the server", async () => {
    const { manager, close } = harness(ready, [
      { code: 0, msg: "", data: [pluginSummary()] },
      {
        code: 40412,
        msg: "plugin not found",
        data: null,
      },
    ]);
    await expect(manager.remove()).rejects.toThrow("plugin not found");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("recognizes an id collision and refuses to overwrite or remove it", async () => {
    const collision = pluginSummary({ displayName: "Someone Else's Plugin" });
    const inspected = harness(ready, [
      { code: 0, msg: "", data: [collision] },
    ]);
    await expect(inspected.manager.inspect()).resolves.toMatchObject({
      owned: false,
    });

    const configured = harness(ready, [
      { code: 0, msg: "", data: [collision] },
    ]);
    await expect(
      configured.manager.configure(SOURCE_DIRECTORY),
    ).rejects.toThrow("A different Kimi plugin");
    expect(configured.fetcher).toHaveBeenCalledTimes(1);

    const removed = harness(ready, [
      { code: 0, msg: "", data: [collision] },
    ]);
    await expect(removed.manager.remove()).rejects.toThrow(
      "A different Kimi plugin",
    );
    expect(removed.fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not enable an unexpected install response", async () => {
    const { manager, fetcher } = harness(ready, [
      { code: 0, msg: "", data: [] },
      {
        code: 0,
        msg: "",
        data: pluginSummary({ id: "different-plugin" }),
      },
    ]);
    await expect(manager.configure(SOURCE_DIRECTORY)).rejects.toThrow(
      "unexpected plugin",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("closes a late spawn and performs no RPC after dispose", async () => {
    let resolveSpawn!: (handle: PluginSessionHandle) => void;
    const close = vi.fn(async () => {});
    const handle: PluginSessionHandle = {
      id: "late-kimi-setup",
      write: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      close,
    };
    const spawn = vi.fn(
      () =>
        new Promise<PluginSessionHandle>((resolve) => {
          resolveSpawn = resolve;
        }),
    );
    const fetcher = vi.fn();
    const manager = createKimiCompanionManager(
      { spawn } as unknown as PluginSessions,
      COMPANION_DESCRIPTOR,
      fetcher as unknown as typeof fetch,
    );

    const inspection = manager.inspect();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    await manager.dispose();
    resolveSpawn(handle);

    await expect(inspection).rejects.toThrow("cancelled");
    expect(close).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("aborts an in-flight RPC when disposed", async () => {
    const close = vi.fn(async () => {});
    const spawn = vi.fn(
      async (_opts: unknown, onEvent: (event: PluginSessionEvent) => void) => {
        onEvent({ type: "output", bytes: encoder.encode(ready) });
        return {
          id: "kimi-setup",
          write: vi.fn(async () => {}),
          resize: vi.fn(async () => {}),
          close,
        };
      },
    );
    const fetcher = vi.fn(
      async (_input: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const manager = createKimiCompanionManager(
      { spawn } as unknown as PluginSessions,
      COMPANION_DESCRIPTOR,
      fetcher,
    );

    const inspection = manager.inspect();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await manager.dispose();

    await expect(inspection).rejects.toThrow("cancelled");
    expect(close).toHaveBeenCalledOnce();
  });
});
