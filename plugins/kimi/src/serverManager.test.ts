import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type {
  PluginSessionEvent,
  PluginSessionHandle,
  PluginSessions,
} from "@keepdeck/plugin-api";
import {
  createKimiServerManager,
  describeStartupOutput,
  extractServerAccess,
  setupServerWrapperScript,
} from "./serverManager";

const encoder = new TextEncoder();
// `--port 0` makes Kimi bind an ephemeral port; the banner carries the real one.
const READY_ORIGIN = "http://127.0.0.1:64999";
const ready = `Kimi server: ${READY_ORIGIN}/#token=secret-token\r\n`;

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
  it("extracts the authenticated endpoint with whatever port Kimi bound", () => {
    expect(
      extractServerAccess(
        `\u001b[32mKimi:\u001b[0m http://127.0.0.1:64999/\u001b[90m#token=abc_123-XYZ\u001b[0m`,
      ),
    ).toEqual({
      origin: "http://127.0.0.1:64999",
      token: "abc_123-XYZ",
    });
    // A different ephemeral port is equally fine — `--port 0` picks any.
    expect(
      extractServerAccess(`http://127.0.0.1:43123/#token=x`),
    ).toEqual({ origin: "http://127.0.0.1:43123", token: "x" });
  });

  it("rejects other hosts and missing credentials", () => {
    expect(extractServerAccess(`http://127.0.0.1:64999/`)).toBeNull();
    expect(
      extractServerAccess(`http://localhost:64999/#token=x`),
    ).toBeNull();
  });
});

describe("describeStartupOutput", () => {
  it("collapses multi-line output and strips terminal control sequences", () => {
    expect(
      describeStartupOutput(
        "\u001b[31mError:\u001b[0m bind failed\r\n\r\n  on port 19120\n",
      ),
    ).toBe("Error: bind failed on port 19120");
  });

  it("keeps the head and marks truncation when the output is long", () => {
    const result = describeStartupOutput("E".repeat(400));
    expect(result).toBe(`${"E".repeat(300)}…`);
    expect(result).toHaveLength(301);
  });

  it("returns empty when the output is only whitespace or control codes", () => {
    expect(describeStartupOutput("\u001b[2J\r\n   \n")).toBe("");
  });
});

describe("setupServerWrapperScript", () => {
  it("is valid sh syntax (parsed with sh -n, not just substring-asserted)", () => {
    expect(() =>
      execFileSync("/bin/sh", ["-n", "-c", setupServerWrapperScript()]),
    ).not.toThrow();
  });

  it("pins the behavioral contract: server flags and watchdog primitives", () => {
    const script = setupServerWrapperScript();
    // `kimi web`, not the removed-in-0.28 `kimi server run`; the debug RPC
    // surface replaced the removed-in-0.29 /api/v2 one; an ephemeral port
    // cannot collide with a second KeepDeck instance.
    expect(script).toContain("kimi web --no-open --host 127.0.0.1");
    expect(script).toContain("--port 0");
    expect(script).toContain("--debug-endpoints");
    // The parent-death watchdog: ignore the PTY's SIGHUP, poll the parent's
    // existence AND start-time identity (pid reuse), escalate TERM → KILL,
    // and reap the watcher's own sleeps so the PTY slave closes promptly.
    expect(script).toContain('trap "" HUP');
    expect(script).toContain('kill -0 "$parent"');
    expect(script).toContain("ps -o lstart=");
    expect(script).toContain('kill "$child"');
    expect(script).toContain('kill -9 "$child"');
    expect(script).toContain("trap 'kill \"$slp\" 2>/dev/null' EXIT");
  });
});

describe("Kimi server manager", () => {
  it("uses one watchdog-wrapped ephemeral-port server for queued operations", async () => {
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
      Array.from({ length: 10 }, () => READY_ORIGIN),
    );
    expect(spawn).toHaveBeenCalledOnce();
    const spawnOptions = spawn.mock.calls[0][0] as {
      command: string;
      args: string[];
    };
    expect(spawnOptions.command).toBe("/bin/sh");
    expect(spawnOptions.args[0]).toBe("-c");
    expect(spawnOptions.args[1]).toBe(setupServerWrapperScript());
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

  it("reports an early exit by code", async () => {
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
      "exited before it became ready (code 1)",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("omits the code when a signal kills the server", async () => {
    const close = vi.fn(async () => {});
    const spawn = vi.fn(
      async (_opts: unknown, onEvent: (event: PluginSessionEvent) => void) => {
        onEvent({ type: "exit", code: null });
        return {
          id: "signal-killed-kimi-setup",
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
      "Kimi setup server exited before it became ready.",
    );
    await expect(failure).rejects.not.toThrow("(code");
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

  it("blames a changed banner on a startup timeout", async () => {
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
      await expect(failure).rejects.toThrow("changed its startup banner");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes the server's own output in a startup-timeout message", async () => {
    vi.useFakeTimers();
    try {
      const partial = "Listening on a different interface; still binding";
      const close = vi.fn(async () => {});
      const spawn = vi.fn(
        async (_opts: unknown, onEvent: (event: PluginSessionEvent) => void) => {
          // Prints partial output but never a parseable address, then hangs.
          onEvent({ type: "output", bytes: encoder.encode(`${partial}\r\n`) });
          return {
            id: "hung-kimi-setup",
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
      failure.catch(() => {});
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(failure).rejects.toThrow("to report its address");
      await expect(failure).rejects.toThrow(`It reported: ${partial}`);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
