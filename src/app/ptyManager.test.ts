import { beforeEach, describe, expect, it, vi } from "vitest";

/** Controllable spawn fake: each call is recorded with its event channel and a
 * deferred result, so tests drive resolution, output and exit explicitly. */
const harness = vi.hoisted(() => {
  interface FakeSpawn {
    opts: { command?: string | null; cwd?: string | null };
    onEvent: (event: { type: string; bytes?: number[]; code?: number | null }) => void;
    resolve: (session: unknown) => void;
    reject: (err: unknown) => void;
  }
  const spawns: FakeSpawn[] = [];
  return {
    spawns,
    spawnSession: (
      opts: FakeSpawn["opts"],
      onEvent: FakeSpawn["onEvent"],
    ): Promise<unknown> =>
      new Promise((resolve, reject) => {
        spawns.push({ opts, onEvent, resolve, reject });
      }),
    makeSession: () => ({
      id: `session-${spawns.length}`,
      write: vi.fn(() => Promise.resolve()),
      resize: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
    }),
    reset: () => {
      spawns.length = 0;
    },
  };
});

vi.mock("../ipc/session", () => ({ spawnSession: harness.spawnSession }));
vi.mock("../ipc/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  describeError: (e: unknown) => String(e),
}));

import {
  acquirePane,
  attachPane,
  closePane,
  isPaneLaunched,
  resetPtyManager,
  writePane,
} from "./ptyManager";

const SPEC = { command: "claude", cwd: "/repo", cols: 80, rows: 24 };

function makeSink() {
  return {
    onOutput: vi.fn(),
    onExit: vi.fn(),
    onSpawnError: vi.fn(),
    onReady: vi.fn(),
    onLaunched: vi.fn(),
  };
}

/** Let the acquire chain's .then/.catch handlers run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function output(index: number, ...bytes: number[]) {
  harness.spawns[index].onEvent({ type: "output", bytes });
}

beforeEach(() => {
  resetPtyManager();
  harness.reset();
  vi.clearAllMocks();
});

describe("acquirePane", () => {
  it("spawns once for a double acquire with the same identity", () => {
    acquirePane("pane-1", SPEC);
    acquirePane("pane-1", SPEC);
    expect(harness.spawns).toHaveLength(1);
  });

  it("does not respawn an exited session on re-acquire (restart is explicit)", async () => {
    acquirePane("pane-1", SPEC);
    harness.spawns[0].resolve(harness.makeSession());
    await settle();
    harness.spawns[0].onEvent({ type: "exit", code: 0 });
    acquirePane("pane-1", SPEC);
    expect(harness.spawns).toHaveLength(1);
  });

  it("respawns exactly once after an explicit close and ignores the retired run", async () => {
    acquirePane("pane-1", SPEC);
    harness.spawns[0].resolve(harness.makeSession());
    await settle();
    const firstSink = makeSink();
    attachPane("pane-1", firstSink);
    harness.spawns[0].onEvent({ type: "exit", code: 0 });

    await closePane("pane-1");
    acquirePane("pane-1", SPEC);
    const restartedSink = makeSink();
    attachPane("pane-1", restartedSink);

    expect(harness.spawns).toHaveLength(2);
    output(0, 7);
    output(1, 8);
    expect(firstSink.onOutput).not.toHaveBeenCalled();
    expect(restartedSink.onOutput).toHaveBeenCalledOnce();
    expect(restartedSink.onOutput).toHaveBeenCalledWith(new Uint8Array([8]));
  });

  it("closes the old session and respawns when the identity changes", async () => {
    acquirePane("pane-1", SPEC);
    const session = harness.makeSession();
    harness.spawns[0].resolve(session);
    await settle();
    acquirePane("pane-1", { ...SPEC, cwd: "/elsewhere" });
    expect(session.close).toHaveBeenCalled();
    expect(harness.spawns).toHaveLength(2);
  });
});

describe("attachPane", () => {
  it("replays output buffered while no view was attached", () => {
    acquirePane("pane-1", SPEC);
    output(0, 1, 2, 3);
    const sink = makeSink();
    attachPane("pane-1", sink);
    expect(sink.onOutput).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  });

  it("streams live output to the attached sink", () => {
    acquirePane("pane-1", SPEC);
    const sink = makeSink();
    attachPane("pane-1", sink);
    output(0, 7);
    expect(sink.onOutput).toHaveBeenCalledWith(new Uint8Array([7]));
  });

  it("announces readiness both on spawn resolution and on late attach", async () => {
    acquirePane("pane-1", SPEC);
    const early = makeSink();
    attachPane("pane-1", early);
    expect(early.onReady).not.toHaveBeenCalled();
    harness.spawns[0].resolve(harness.makeSession());
    await settle();
    expect(early.onReady).toHaveBeenCalledTimes(1);

    const late = makeSink();
    attachPane("pane-1", late);
    expect(late.onReady).toHaveBeenCalledTimes(1);
  });

  it("tells a late sink about an exit it missed, after the replay", async () => {
    acquirePane("pane-1", SPEC);
    harness.spawns[0].resolve(harness.makeSession());
    await settle();
    output(0, 9);
    harness.spawns[0].onEvent({ type: "exit", code: 1 });

    const sink = makeSink();
    attachPane("pane-1", sink);
    expect(sink.onOutput).toHaveBeenCalledWith(new Uint8Array([9]));
    expect(sink.onExit).toHaveBeenCalledWith(1);
  });

  it("tells current and future sinks about a spawn failure", async () => {
    acquirePane("pane-1", SPEC);
    const sink = makeSink();
    attachPane("pane-1", sink);
    harness.spawns[0].reject(new Error("no such command"));
    await settle();
    expect(sink.onSpawnError).toHaveBeenCalledWith("Error: no such command");

    const late = makeSink();
    attachPane("pane-1", late);
    expect(late.onSpawnError).toHaveBeenCalledWith("Error: no such command");
  });

  it("a stale detach does not disconnect the newer sink (StrictMode order)", () => {
    acquirePane("pane-1", SPEC);
    const first = makeSink();
    const detachFirst = attachPane("pane-1", first);
    const second = makeSink();
    attachPane("pane-1", second);
    detachFirst();
    output(0, 5);
    expect(second.onOutput).toHaveBeenCalledWith(new Uint8Array([5]));
    expect(first.onOutput).not.toHaveBeenCalledWith(new Uint8Array([5]));
  });

  it("drops the oldest chunks once the replay budget overflows", () => {
    acquirePane("pane-1", SPEC);
    const half = 512 * 1024;
    harness.spawns[0].onEvent({
      type: "output",
      bytes: Array.from(new Uint8Array(half).fill(1)),
    });
    harness.spawns[0].onEvent({
      type: "output",
      bytes: Array.from(new Uint8Array(half).fill(2)),
    });
    harness.spawns[0].onEvent({
      type: "output",
      bytes: Array.from(new Uint8Array(half).fill(3)),
    });
    const sink = makeSink();
    attachPane("pane-1", sink);
    expect(sink.onOutput).toHaveBeenCalledTimes(2);
    expect((sink.onOutput.mock.calls[0][0] as Uint8Array)[0]).toBe(2);
    expect((sink.onOutput.mock.calls[1][0] as Uint8Array)[0]).toBe(3);
  });
});

describe("launch signal", () => {
  it("reports launch on the first output only, and marks the pane launched", () => {
    acquirePane("pane-1", SPEC);
    const sink = makeSink();
    attachPane("pane-1", sink);
    expect(isPaneLaunched("pane-1")).toBe(false);

    output(0, 1);
    output(0, 2);

    expect(sink.onLaunched).toHaveBeenCalledTimes(1);
    expect(isPaneLaunched("pane-1")).toBe(true);
  });

  it("does not report launch before any output — a spawned PTY has not yet painted", async () => {
    acquirePane("pane-1", SPEC);
    const sink = makeSink();
    attachPane("pane-1", sink);
    harness.spawns[0].resolve(harness.makeSession());
    await settle();

    expect(sink.onReady).toHaveBeenCalledTimes(1);
    expect(sink.onLaunched).not.toHaveBeenCalled();
    expect(isPaneLaunched("pane-1")).toBe(false);
  });

  it("tells a late sink the session already launched, after the replay", () => {
    acquirePane("pane-1", SPEC);
    output(0, 9);

    const late = makeSink();
    attachPane("pane-1", late);

    expect(late.onLaunched).toHaveBeenCalledTimes(1);
    // The replayed output lands before the launch announcement, so the view
    // paints its history and only then drops the overlay.
    const outputOrder = late.onOutput.mock.invocationCallOrder[0];
    const launchOrder = late.onLaunched.mock.invocationCallOrder[0];
    expect(outputOrder).toBeLessThan(launchOrder);
  });

  it("forgets the launch when the identity changes — the new session must show its own overlay", async () => {
    acquirePane("pane-1", SPEC);
    harness.spawns[0].resolve(harness.makeSession());
    await settle();
    output(0, 4);
    expect(isPaneLaunched("pane-1")).toBe(true);

    acquirePane("pane-1", { ...SPEC, cwd: "/elsewhere" });
    expect(isPaneLaunched("pane-1")).toBe(false);
  });

  it("is false for an unknown or closed pane", () => {
    expect(isPaneLaunched("pane-none")).toBe(false);
    acquirePane("pane-1", SPEC);
    output(0, 1);
    void closePane("pane-1");
    expect(isPaneLaunched("pane-1")).toBe(false);
  });
});

describe("closePane", () => {
  it("closes the live session and forgets the pane", async () => {
    acquirePane("pane-1", SPEC);
    const session = harness.makeSession();
    harness.spawns[0].resolve(session);
    await settle();
    await closePane("pane-1");
    expect(session.close).toHaveBeenCalled();
    writePane("pane-1", "x");
    expect(session.write).not.toHaveBeenCalled();
  });

  it("reaps a spawn that resolves after the pane was closed", async () => {
    acquirePane("pane-1", SPEC);
    void closePane("pane-1");
    const session = harness.makeSession();
    harness.spawns[0].resolve(session);
    await settle();
    expect(session.close).toHaveBeenCalled();
  });

  it("silences events from a closed pane", () => {
    acquirePane("pane-1", SPEC);
    const sink = makeSink();
    attachPane("pane-1", sink);
    void closePane("pane-1");
    output(0, 1);
    expect(sink.onOutput).not.toHaveBeenCalled();
  });
});

describe("writePane", () => {
  it("writes through to the live session", async () => {
    acquirePane("pane-1", SPEC);
    const session = harness.makeSession();
    harness.spawns[0].resolve(session);
    await settle();
    writePane("pane-1", "ls\n");
    expect(session.write).toHaveBeenCalledWith("ls\n");
  });

  it("is a no-op for unknown panes and pending spawns", () => {
    expect(() => writePane("pane-none", "x")).not.toThrow();
    acquirePane("pane-1", SPEC);
    expect(() => writePane("pane-1", "x")).not.toThrow();
  });
});
