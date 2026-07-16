import { describe, expect, it, vi } from "vitest";
import {
  COMPANION_DESCRIPTOR,
  COMPANION_ID,
  COMPANION_VERSION,
} from "./companion";
import { createKimiCompanionManager } from "./manager";
import {
  KIMI_SETUP_SERVER_PORT,
  type KimiServerManager,
} from "./serverManager";

const SOURCE_DIRECTORY = "/App/resources/keepdeck-session-reporter";
const ACCESS = {
  origin: `http://127.0.0.1:${KIMI_SETUP_SERVER_PORT}`,
  token: "secret-token",
};

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
  responses: unknown[] = [{ code: 0, msg: "", data: null }],
) {
  const abort = new AbortController();
  const run = vi.fn(
    async (
      operation: (
        access: typeof ACCESS,
        signal: AbortSignal,
      ) => Promise<unknown>,
    ) => operation(ACCESS, abort.signal),
  ) as unknown as KimiServerManager["run"];
  const dispose = vi.fn(async () => abort.abort());
  const server: KimiServerManager = { run, dispose };
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
    server,
    COMPANION_DESCRIPTOR,
    fetcher,
  );
  return { manager, server, run, dispose, fetcher, abort };
}

describe("Kimi companion manager", () => {
  it("configures and verifies the reporter in one server transaction", async () => {
    const { manager, run, fetcher } = harness([
      { code: 0, msg: "", data: [] },
      {
        code: 0,
        msg: "",
        data: pluginSummary({ enabled: false }),
      },
      { code: 0, msg: "", data: null },
      { code: 0, msg: "", data: [pluginSummary()] },
    ]);

    await expect(manager.configure(SOURCE_DIRECTORY)).resolves.toEqual({
      version: COMPANION_VERSION,
      enabled: true,
      healthy: true,
      owned: true,
    });

    expect(run).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      `${ACCESS.origin}/api/v2/pluginService/installPlugin`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer secret-token",
        }),
        body: JSON.stringify({ source: SOURCE_DIRECTORY }),
        redirect: "error",
      }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      `${ACCESS.origin}/api/v2/pluginService/setPluginEnabled`,
      expect.objectContaining({
        body: JSON.stringify({ id: COMPANION_ID, enabled: true }),
      }),
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("inspects the actual Kimi installation state", async () => {
    const { manager } = harness([
      { code: 0, msg: "", data: [pluginSummary()] },
    ]);
    await expect(manager.inspect()).resolves.toEqual({
      version: COMPANION_VERSION,
      enabled: true,
      healthy: true,
      owned: true,
    });
  });

  it("reports an absent companion from Kimi's empty plugin list", async () => {
    const { manager } = harness([{ code: 0, msg: "", data: [] }]);
    await expect(manager.inspect()).resolves.toBeNull();
  });

  it("removes and verifies absence in one server transaction", async () => {
    const { manager, run, fetcher } = harness([
      { code: 0, msg: "", data: [pluginSummary()] },
      { code: 0, msg: "", data: null },
      { code: 0, msg: "", data: [] },
    ]);

    await expect(manager.remove()).resolves.toBeNull();
    expect(run).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      `${ACCESS.origin}/api/v2/pluginService/removePlugin`,
      expect.objectContaining({
        body: JSON.stringify({ id: COMPANION_ID }),
      }),
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("surfaces Kimi's API error", async () => {
    const { manager } = harness([
      { code: 0, msg: "", data: [pluginSummary()] },
      { code: 40412, msg: "plugin not found", data: null },
    ]);
    await expect(manager.remove()).rejects.toThrow("plugin not found");
  });

  it("recognizes an id collision and refuses to overwrite or remove it", async () => {
    const collision = pluginSummary({ displayName: "Someone Else's Plugin" });
    const inspected = harness([
      { code: 0, msg: "", data: [collision] },
    ]);
    await expect(inspected.manager.inspect()).resolves.toMatchObject({
      owned: false,
    });

    const configured = harness([
      { code: 0, msg: "", data: [collision] },
    ]);
    await expect(
      configured.manager.configure(SOURCE_DIRECTORY),
    ).rejects.toThrow("A different Kimi plugin");
    expect(configured.fetcher).toHaveBeenCalledOnce();

    const removed = harness([
      { code: 0, msg: "", data: [collision] },
    ]);
    await expect(removed.manager.remove()).rejects.toThrow(
      "A different Kimi plugin",
    );
    expect(removed.fetcher).toHaveBeenCalledOnce();
  });

  it("does not enable an unexpected install response", async () => {
    const { manager, fetcher } = harness([
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

  it("rejects configure when final verification does not match", async () => {
    const { manager } = harness([
      { code: 0, msg: "", data: [] },
      {
        code: 0,
        msg: "",
        data: pluginSummary({ enabled: false }),
      },
      { code: 0, msg: "", data: null },
      {
        code: 0,
        msg: "",
        data: [pluginSummary({ enabled: false })],
      },
    ]);
    await expect(manager.configure(SOURCE_DIRECTORY)).rejects.toThrow(
      "could not verify",
    );
  });

  it("aborts an in-flight RPC when the server transaction is cancelled", async () => {
    const abort = new AbortController();
    const run = vi.fn(
      async (
        operation: (
          access: typeof ACCESS,
          signal: AbortSignal,
        ) => Promise<unknown>,
      ) => operation(ACCESS, abort.signal),
    ) as unknown as KimiServerManager["run"];
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
      { run, dispose: vi.fn(async () => {}) },
      COMPANION_DESCRIPTOR,
      fetcher,
    );

    const inspection = manager.inspect();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    abort.abort();

    await expect(inspection).rejects.toThrow("cancelled");
  });
});
