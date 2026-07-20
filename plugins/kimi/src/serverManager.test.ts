import { describe, expect, it, vi } from "vitest";
import type {
  PluginSessionEvent,
  PluginSessionHandle,
  PluginSessions,
} from "@keepdeck/plugin-api";
import {
  createKimiServerManager,
  extractServerAccess,
  KIMI_SETUP_SERVER_PORT,
} from "./serverManager";

const encoder = new TextEncoder();
const ready =
  `Kimi server: http://127.0.0.1:${KIMI_SETUP_SERVER_PORT}/#token=secret-token\r\n`;

function sessionHarness(output = ready) {
  const close = vi.fn(async () => {});
  const handle: PluginSessionHandle = {
    id: "kimi-setup",
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    close,
  };
  const spawn = vi.fn(
    async (_opts: unknown, onEvent: (event: PluginSessionEvent) => void) => {
      onEvent({ type: "output", bytes: encoder.encode(output) });
      return handle;
    },
  );
  const manager = createKimiServerManager(
    { spawn } as unknown as PluginSessions,
  );
  return { manager, spawn, handle, close };
}

describe("Kimi setup server access", () => {
  it("extracts only the authenticated endpoint on the fixed port", () => {
    expect(
      extractServerAccess(
        `\u001b[32mKimi:\u001b[0m http://127.0.0.1:${KIMI_SETUP_SERVER_PORT}/\u001b[90m#token=abc_123-XYZ\u001b[0m`,
      ),
    ).toEqual({
      origin: `http://127.0.0.1:${KIMI_SETUP_SERVER_PORT}`,
      token: "abc_123-XYZ",
    });
  });

  it("rejects other hosts, ports and missing credentials", () => {
    expect(
      extractServerAccess(
        `http://127.0.0.1:${KIMI_SETUP_SERVER_PORT}/`,
      ),
    ).toBeNull();
    expect(
      extractServerAccess("http://127.0.0.1:43123/#token=x"),
    ).toBeNull();
    expect(
      extractServerAccess(
        `http://localhost:${KIMI_SETUP_SERVER_PORT}/#token=x`,
      ),
    ).toBeNull();
  });
});

describe("Kimi server manager", () => {
  it("uses one fixed-port foreground server for queued operations", async () => {
    const { manager, spawn, close } = sessionHarness();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const operation = (name: string, gate?: Promise<void>) =>
      manager.run(async (access) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`${name}:start`);
        await gate;
        order.push(`${name}:end`);
        active -= 1;
        return access.origin;
      });

    const first = operation("first", firstGate);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const queued = Array.from({ length: 9 }, (_, index) =>
      operation(`queued-${index + 1}`),
    );
    releaseFirst();

    await expect(Promise.all([first, ...queued])).resolves.toEqual(
      Array.from(
        { length: 10 },
        () => `http://127.0.0.1:${KIMI_SETUP_SERVER_PORT}`,
      ),
    );
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kimi",
        // `kimi web`, not the removed-in-0.28 `kimi server run`.
        args: [
          "web",
          "--no-open",
          "--host",
          "127.0.0.1",
          "--port",
          String(KIMI_SETUP_SERVER_PORT),
          "--log-level",
          "silent",
        ],
      }),
      expect.any(Function),
    );
    expect(maxActive).toBe(1);
    expect(order).toEqual([
      "first:start",
      "first:end",
      ...Array.from({ length: 9 }, (_, index) => [
        `queued-${index + 1}:start`,
        `queued-${index + 1}:end`,
      ]).flat(),
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the queue usable after one operation fails", async () => {
    const { manager, spawn, close } = sessionHarness();
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const failed = manager.run(async () => {
      await failureGate;
      throw new Error("operation failed");
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const recovered = manager.run(async () => "recovered");
    releaseFailure();

    await expect(failed).rejects.toThrow("operation failed");
    await expect(recovered).resolves.toBe("recovered");
    expect(spawn).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a late spawn and runs no operation after dispose", async () => {
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
    const manager = createKimiServerManager(
      { spawn } as unknown as PluginSessions,
    );
    const operation = vi.fn(async () => {});

    const pending = manager.run(operation);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const disposal = manager.dispose();
    resolveSpawn(handle);

    await disposal;
    await expect(pending).rejects.toThrow("cancelled");
    expect(operation).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("aborts active work and rejects future work on dispose", async () => {
    const { manager, close } = sessionHarness();
    const started = vi.fn();
    const operation = manager.run(
      async (_access, signal) => {
        started();
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("operation aborted")),
            { once: true },
          );
        });
      },
    );
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());

    await manager.dispose();

    await expect(operation).rejects.toThrow("operation aborted");
    await expect(manager.run(async () => {})).rejects.toThrow("cancelled");
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports an early exit by code without blaming the port", async () => {
    const close = vi.fn(async () => {});
    const spawn = vi.fn(
      async (_opts: unknown, onEvent: (event: PluginSessionEvent) => void) => {
        onEvent({ type: "exit", code: 1 });
        return {
          id: "failed-kimi-setup",
          write: vi.fn(async () => {}),
          resize: vi.fn(async () => {}),
          close,
        };
      },
    );
    const manager = createKimiServerManager(
      { spawn } as unknown as PluginSessions,
    );

    const failure = manager.run(async () => {});
    await expect(failure).rejects.toThrow(
      `exited before it became ready on 127.0.0.1:${KIMI_SETUP_SERVER_PORT} (code 1)`,
    );
    // A busy port makes `kimi web` hang, not exit, so it must not be blamed here.
    await expect(failure).rejects.not.toThrow("port may already be in use");
    expect(close).toHaveBeenCalledOnce();
  });

  it("surfaces the server's own output when it exits early", async () => {
    const notice = "`kimi server` has been deprecated and no longer works.";
    const close = vi.fn(async () => {});
    const spawn = vi.fn(
      async (_opts: unknown, onEvent: (event: PluginSessionEvent) => void) => {
        onEvent({ type: "output", bytes: encoder.encode(`${notice}\r\n`) });
        onEvent({ type: "exit", code: 1 });
        return {
          id: "deprecated-kimi-setup",
          write: vi.fn(async () => {}),
          resize: vi.fn(async () => {}),
          close,
        };
      },
    );
    const manager = createKimiServerManager(
      { spawn } as unknown as PluginSessions,
    );

    await expect(manager.run(async () => {})).rejects.toThrow(notice);
    expect(close).toHaveBeenCalledOnce();
  });

  it("blames a busy port or changed banner only on a startup timeout", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn(async () => {});
      const handle: PluginSessionHandle = {
        id: "silent-kimi-setup",
        write: vi.fn(async () => {}),
        resize: vi.fn(async () => {}),
        close,
      };
      // Resolves a live handle but never reports an address and never exits.
      const spawn = vi.fn(async () => handle);
      const manager = createKimiServerManager(
        { spawn } as unknown as PluginSessions,
      );

      const failure = manager.run(async () => {});
      failure.catch(() => {});
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(failure).rejects.toThrow("to report its address");
      await expect(failure).rejects.toThrow("port may already be in use");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
