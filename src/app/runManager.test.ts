import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "../ipc/session";

const ports = vi.hoisted(() => ({ allocatePorts: vi.fn() }));
vi.mock("../ipc/ports", () => ports);

/** One fake PTY per spawn: capture the event channel, expose a close spy
 * that emits the exit event like the real backend does. */
const pty = vi.hoisted(() => {
  const spawned: Array<{
    opts: Record<string, unknown>;
    emit: (e: SessionEvent) => void;
    close: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
  }> = [];
  return {
    spawned,
    spawnSession: vi.fn(async (opts: Record<string, unknown>, onEvent: (e: SessionEvent) => void) => {
      const record = {
        opts,
        emit: onEvent,
        close: vi.fn(async () => {
          onEvent({ type: "exit", success: false, code: null });
        }),
        resize: vi.fn(async () => {}),
      };
      spawned.push(record);
      return {
        id: `s${spawned.length}`,
        write: async () => {},
        resize: record.resize,
        close: record.close,
      };
    }),
  };
});
vi.mock("../ipc/session", () => ({ spawnSession: pty.spawnSession }));

import {
  attachRun,
  getRunSessions,
  launchRun,
  removeRun,
  resetRunManager,
  restartRun,
  stopRun,
  stopWorkspaceRuns,
} from "./runManager";

beforeEach(() => {
  vi.clearAllMocks();
  pty.spawned.length = 0;
  ports.allocatePorts.mockResolvedValue(17_040);
});
afterEach(resetRunManager);

const DEV = { presetId: "run-1", command: "pnpm dev", name: "Dev" };
const TARGET = { worktree: "/wt/1", branch: "kd/1" };

describe("launchRun", () => {
  it("allocates the port, spawns shell -c with the env contract, snapshots running", async () => {
    const id = await launchRun("ws-1", TARGET, DEV);

    expect(ports.allocatePorts).toHaveBeenCalledWith("/wt/1");
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
    const [session] = getRunSessions();
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
    ports.allocatePorts.mockRejectedValue(new Error("exhausted"));
    await launchRun("ws-1", TARGET, DEV);

    const env = (pty.spawned[0].opts.env as [string, string][]).map(([k]) => k);
    expect(env).not.toContain("KEEPDECK_PORT");
    expect(getRunSessions()[0].port).toBeUndefined();
  });

  it("exit and spawn failure land in the status", async () => {
    await launchRun("ws-1", TARGET, DEV);
    pty.spawned[0].emit({ type: "exit", success: false, code: 1 });
    expect(getRunSessions()[0].status).toEqual({ kind: "exited", code: 1 });

    pty.spawnSession.mockRejectedValueOnce(new Error("no shell"));
    await launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => {
      expect(getRunSessions()[1].status).toEqual({
        kind: "failed",
        message: expect.stringContaining("no shell") as unknown as string,
      });
    });
  });

  it("snapshots are stable between changes", async () => {
    await launchRun("ws-1", TARGET, DEV);
    const first = getRunSessions();
    expect(getRunSessions()).toBe(first);
    pty.spawned[0].emit({ type: "output", bytes: [104, 105] });
    // Output alone is not a session change — no snapshot churn.
    expect(getRunSessions()).toBe(first);
  });
});

describe("stop / restart / remove", () => {
  it("stopRun closes the handle (group kill behind it) and reports stopping → exited", async () => {
    const id = await launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));

    stopRun(id);
    expect(pty.spawned[0].close).toHaveBeenCalled();
    // The fake close emitted the exit event, as the real backend does.
    expect(getRunSessions()[0].status).toEqual({ kind: "exited", code: null });
  });

  it("restartRun respawns with a fresh port and a clean buffer", async () => {
    ports.allocatePorts.mockResolvedValueOnce(17_040).mockResolvedValueOnce(17_050);
    const id = await launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    pty.spawned[0].emit({ type: "output", bytes: [111, 108, 100] }); // "old"
    pty.spawned[0].emit({ type: "exit", success: false, code: 1 });

    await restartRun(id);
    expect(pty.spawned).toHaveLength(2);
    expect(getRunSessions()[0]).toMatchObject({
      port: 17_050,
      status: { kind: "running" },
    });
    // The old output must not replay into the fresh run's log.
    const seen: number[] = [];
    attachRun(id, { onOutput: (b) => seen.push(...b) });
    expect(seen).toEqual([]);
  });

  it("removeRun kills a live session and drops it from the snapshot", async () => {
    const id = await launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));

    removeRun(id);
    expect(pty.spawned[0].close).toHaveBeenCalled();
    expect(getRunSessions()).toHaveLength(0);
  });

  it("stopWorkspaceRuns takes down exactly that workspace's runs", async () => {
    await launchRun("ws-1", TARGET, DEV);
    await launchRun("ws-2", { worktree: "/wt/2" }, { command: "go run .", name: "srv" });
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(2));

    stopWorkspaceRuns("ws-1");
    const left = getRunSessions();
    expect(left).toHaveLength(1);
    expect(left[0].wsId).toBe("ws-2");
    expect(pty.spawned[0].close).toHaveBeenCalled();
    expect(pty.spawned[1].close).not.toHaveBeenCalled();
  });
});

describe("attachRun", () => {
  it("replays buffered output, then streams live", async () => {
    const id = await launchRun("ws-1", TARGET, DEV);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    pty.spawned[0].emit({ type: "output", bytes: [1, 2] });

    const seen: number[] = [];
    const detach = attachRun(id, { onOutput: (b) => seen.push(...b) });
    expect(seen).toEqual([1, 2]); // replay
    pty.spawned[0].emit({ type: "output", bytes: [3] });
    expect(seen).toEqual([1, 2, 3]); // live

    detach();
    pty.spawned[0].emit({ type: "output", bytes: [4] });
    expect(seen).toEqual([1, 2, 3]); // detached views hear nothing
  });
});
