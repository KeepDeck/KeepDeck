import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { log } from "../ipc/log";
import { createPtyManager, type PtyManager } from "./ptyManager";
import { createSessionDoor, exitEvent, type SessionDoor } from "./ptyManager.testSupport";

/** The door to the sessions machine — each test drives its spawns' results,
 * output and exits — and a fresh real registry behind it. */
let harness: SessionDoor;
let registry: PtyManager;

const SPEC = { command: "claude", cwd: "/repo", cols: 80, rows: 24 };
/** The lease the funnel got for the pane. */
const LAUNCH = { permit: 41, owner: { kind: "pane", pane: "pane-1" } } as const;

function makeSink() {
  return {
    onOutput: vi.fn<(bytes: Uint8Array) => void>(),
    onExit: vi.fn(),
    onSpawnError: vi.fn(),
    onReady: vi.fn(),
    onLaunched: vi.fn(),
  };
}

/** Let the acquire chain's .then/.catch handlers run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function output(index: number, ...bytes: number[]) {
  harness.spawns[index].onEvent({ type: "output", bytes: Uint8Array.from(bytes) });
}

beforeEach(() => {
  harness = createSessionDoor();
  registry = createPtyManager(harness.open);
  vi.clearAllMocks();
});

describe("acquirePane", () => {
  it("spends the lease it was handed at the spawn door — the permit, and the owner it names", () => {
    // The bridge takes a pane's reports only from processes in its terminal;
    // the door keys the terminal by the owner the lease was granted to.
    const launch = { permit: 7, owner: { kind: "pane", pane: "pane-7" } } as const;
    registry.acquire("pane-7", SPEC, launch);
    expect(harness.spawns[0]).toMatchObject({ permit: 7, owner: launch.owner });
  });

  it("spawns once for a double acquire with the same identity", () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    registry.acquire("pane-1", SPEC, LAUNCH);
    expect(harness.spawns).toHaveLength(1);
  });

  it("does not respawn an exited session on re-acquire (restart is explicit)", async () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    harness.spawns[0].resolve(harness.makeSession());
    await settle();
    harness.spawns[0].onEvent(exitEvent(0));
    registry.acquire("pane-1", SPEC, LAUNCH);
    expect(harness.spawns).toHaveLength(1);
  });

  it("respawns exactly once after an explicit close and ignores the retired run", async () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    harness.spawns[0].resolve(harness.makeSession());
    await settle();
    const firstSink = makeSink();
    registry.attach("pane-1", firstSink);
    harness.spawns[0].onEvent(exitEvent(0));

    await registry.close("pane-1");
    registry.acquire("pane-1", SPEC, LAUNCH);
    const restartedSink = makeSink();
    registry.attach("pane-1", restartedSink);

    expect(harness.spawns).toHaveLength(2);
    output(0, 7);
    output(1, 8);
    expect(firstSink.onOutput).not.toHaveBeenCalled();
    expect(restartedSink.onOutput).toHaveBeenCalledOnce();
    expect(restartedSink.onOutput).toHaveBeenCalledWith(new Uint8Array([8]));
  });

  it("closes the old session and respawns when the identity changes", async () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    const session = harness.makeSession();
    harness.spawns[0].resolve(session);
    await settle();
    registry.acquire("pane-1", { ...SPEC, cwd: "/elsewhere" }, LAUNCH);
    expect(session.stop).toHaveBeenCalled();
    expect(harness.spawns).toHaveLength(2);
  });
});

describe("attachPane", () => {
  it("replays output buffered while no view was attached", () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    output(0, 1, 2, 3);
    const sink = makeSink();
    registry.attach("pane-1", sink);
    expect(sink.onOutput).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  });

  it("streams live output to the attached sink", () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    const sink = makeSink();
    registry.attach("pane-1", sink);
    output(0, 7);
    expect(sink.onOutput).toHaveBeenCalledWith(new Uint8Array([7]));
  });

  it("announces readiness both on spawn resolution and on late attach", async () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    const early = makeSink();
    registry.attach("pane-1", early);
    expect(early.onReady).not.toHaveBeenCalled();
    harness.spawns[0].resolve(harness.makeSession());
    await settle();
    expect(early.onReady).toHaveBeenCalledTimes(1);

    const late = makeSink();
    registry.attach("pane-1", late);
    expect(late.onReady).toHaveBeenCalledTimes(1);
  });

  it("takes a listener that arrives BEFORE the session and feeds it from the first event", async () => {
    // The view mounts when the deck renders it; the process starts when the
    // orchestrator decides it should. Neither waits for the other, so a
    // listener that arrives first used to attach to nothing and sit empty.
    const sink = makeSink();
    registry.attach("pane-1", sink);

    registry.acquire("pane-1", SPEC, LAUNCH);
    harness.spawns[0].resolve(harness.makeSession());
    await settle();
    expect(sink.onReady).toHaveBeenCalled();

    output(0, 7);
    expect(sink.onOutput).toHaveBeenCalledWith(new Uint8Array([7]));
    expect(sink.onLaunched).toHaveBeenCalledTimes(1);
  });

  it("keeps the listener across a session being replaced under it", async () => {
    // A restart closes the process and spawns another into the same pane. The
    // terminal is not remounted for that, so dropping its listener on close
    // would leave it showing a session nobody is feeding.
    const sink = makeSink();
    registry.acquire("pane-1", SPEC, LAUNCH);
    registry.attach("pane-1", sink);
    await registry.close("pane-1");

    registry.acquire("pane-1", SPEC, LAUNCH);
    harness.spawns[1].resolve(harness.makeSession());
    await settle();
    output(1, 5);
    expect(sink.onOutput).toHaveBeenCalledWith(new Uint8Array([5]));
  });

  it("a death nobody heard reaches its FIRST listener as live; later attaches replay", async () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    harness.spawns[0].resolve(harness.makeSession());
    await settle();
    output(0, 9);
    // The exit lands with no sink attached (the detach/re-attach window).
    harness.spawns[0].onEvent(exitEvent(1));

    const first = makeSink();
    registry.attach("pane-1", first);
    expect(first.onOutput).toHaveBeenCalledWith(new Uint8Array([9]));
    expect(first.onExit).toHaveBeenCalledWith(1, false); // once-per-death fires

    const second = makeSink();
    registry.attach("pane-1", second);
    expect(second.onExit).toHaveBeenCalledWith(1, true); // now it's history
  });

  it("marks the live death and its re-announcements apart (once-per-death reactions)", async () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    const live = makeSink();
    registry.attach("pane-1", live);
    harness.spawns[0].resolve(harness.makeSession());
    await settle();
    harness.spawns[0].onEvent(exitEvent(137));
    // The attached view hears the actual death, unreplayed.
    expect(live.onExit).toHaveBeenCalledWith(137, false);

    // A remount over the same (exited, not closed) pane: acquire reuses the
    // entry, attach re-announces — flagged as a replay.
    registry.acquire("pane-1", SPEC, LAUNCH);
    const remounted = makeSink();
    registry.attach("pane-1", remounted);
    expect(remounted.onExit).toHaveBeenCalledWith(137, true);
    expect(remounted.onExit).toHaveBeenCalledTimes(1);
  });

  it("tells current and future sinks about a spawn failure — live once, replays after", async () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    const sink = makeSink();
    registry.attach("pane-1", sink);
    harness.spawns[0].reject(new Error("no such command"));
    await settle();
    expect(sink.onSpawnError).toHaveBeenCalledWith(
      "no such command",
      false,
    );

    const late = makeSink();
    registry.attach("pane-1", late);
    expect(late.onSpawnError).toHaveBeenCalledWith(
      "no such command",
      true,
    );
  });

  it("a spawn failure nobody heard is live for its first listener", async () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    harness.spawns[0].reject(new Error("boom"));
    await settle(); // fails with no sink attached — the detached window

    const first = makeSink();
    registry.attach("pane-1", first);
    expect(first.onSpawnError).toHaveBeenCalledWith("boom", false);

    const second = makeSink();
    registry.attach("pane-1", second);
    expect(second.onSpawnError).toHaveBeenCalledWith("boom", true);
  });

  it("a stale detach does not disconnect the newer sink (StrictMode order)", () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    const first = makeSink();
    const detachFirst = registry.attach("pane-1", first);
    const second = makeSink();
    registry.attach("pane-1", second);
    detachFirst();
    output(0, 5);
    expect(second.onOutput).toHaveBeenCalledWith(new Uint8Array([5]));
    expect(first.onOutput).not.toHaveBeenCalledWith(new Uint8Array([5]));
  });

  it("drops the oldest chunks once the replay budget overflows", () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    const half = 512 * 1024;
    harness.spawns[0].onEvent({
      type: "output",
      bytes: new Uint8Array(half).fill(1),
    });
    harness.spawns[0].onEvent({
      type: "output",
      bytes: new Uint8Array(half).fill(2),
    });
    harness.spawns[0].onEvent({
      type: "output",
      bytes: new Uint8Array(half).fill(3),
    });
    const sink = makeSink();
    registry.attach("pane-1", sink);
    expect(sink.onOutput).toHaveBeenCalledTimes(2);
    expect(sink.onOutput.mock.calls[0][0][0]).toBe(2);
    expect(sink.onOutput.mock.calls[1][0][0]).toBe(3);
  });
});

describe("startup diagnostics", () => {
  const messages = () =>
    vi.mocked(log.info).mock.calls.map(([, message]) => message as string);

  it("logs the spawn resolution once, and only after the spawn settles", async () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    expect(messages().some((m) => m.includes("spawn resolved"))).toBe(false);

    harness.spawns[0].resolve(harness.makeSession());
    await settle();

    expect(messages().filter((m) => m.includes("pane-1: spawn resolved"))).toHaveLength(1);
  });

  it("logs the first output once, not once per chunk, and without the bytes", () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    output(0, 65, 66);
    output(0, 67);

    expect(messages().filter((m) => m.includes("pane-1: first output"))).toHaveLength(1);
    expect(messages().some((m) => /6[567]/.test(m))).toBe(false);
  });

});

describe("launch signal", () => {
  it("reports launch on the first output only, and marks the pane launched", () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    const sink = makeSink();
    registry.attach("pane-1", sink);
    expect(registry.isLaunched("pane-1")).toBe(false);

    output(0, 1);
    output(0, 2);

    expect(sink.onLaunched).toHaveBeenCalledTimes(1);
    expect(registry.isLaunched("pane-1")).toBe(true);
  });

  it("marks the pane launched even when the sink's onOutput throws", () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    const sink = makeSink();
    sink.onOutput.mockImplementation(() => {
      throw new Error("boom");
    });
    registry.attach("pane-1", sink);

    output(0, 1);

    expect(registry.isLaunched("pane-1")).toBe(true);
    expect(sink.onLaunched).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      "web:pty",
      expect.stringContaining("onOutput threw"),
    );
  });

  it("keeps buffering for replay when the sink throws on every chunk", () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    const throwing = makeSink();
    throwing.onOutput.mockImplementation(() => {
      throw new Error("boom");
    });
    registry.attach("pane-1", throwing);

    output(0, 7);

    const late = makeSink();
    registry.attach("pane-1", late);
    expect(late.onOutput).toHaveBeenCalledTimes(1);
    expect(late.onOutput.mock.calls[0][0][0]).toBe(7);
  });

  it("does not report launch before any output — a spawned PTY has not yet painted", async () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    const sink = makeSink();
    registry.attach("pane-1", sink);
    harness.spawns[0].resolve(harness.makeSession());
    await settle();

    expect(sink.onReady).toHaveBeenCalledTimes(1);
    expect(sink.onLaunched).not.toHaveBeenCalled();
    expect(registry.isLaunched("pane-1")).toBe(false);
  });

  it("tells a late sink the session already launched, after the replay", () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    output(0, 9);

    const late = makeSink();
    registry.attach("pane-1", late);

    expect(late.onLaunched).toHaveBeenCalledTimes(1);
    // The replayed output lands before the launch announcement, so the view
    // paints its history and only then drops the overlay.
    const outputOrder = late.onOutput.mock.invocationCallOrder[0];
    const launchOrder = late.onLaunched.mock.invocationCallOrder[0];
    expect(outputOrder).toBeLessThan(launchOrder);
  });

  it("forgets the launch when the identity changes — the new session must show its own overlay", async () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    harness.spawns[0].resolve(harness.makeSession());
    await settle();
    output(0, 4);
    expect(registry.isLaunched("pane-1")).toBe(true);

    registry.acquire("pane-1", { ...SPEC, cwd: "/elsewhere" }, LAUNCH);
    expect(registry.isLaunched("pane-1")).toBe(false);
  });

  it("is false for an unknown or closed pane", () => {
    expect(registry.isLaunched("pane-none")).toBe(false);
    registry.acquire("pane-1", SPEC, LAUNCH);
    output(0, 1);
    void registry.close("pane-1");
    expect(registry.isLaunched("pane-1")).toBe(false);
  });
});

describe("closePane", () => {
  it("closes the live session and forgets the pane", async () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    const session = harness.makeSession();
    harness.spawns[0].resolve(session);
    await settle();
    await registry.close("pane-1");
    expect(session.stop).toHaveBeenCalled();
    registry.write("pane-1", "x");
    expect(session.write).not.toHaveBeenCalled();
  });

  it("reaps a spawn that resolves after the pane was closed", async () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    void registry.close("pane-1");
    const session = harness.makeSession();
    harness.spawns[0].resolve(session);
    await settle();
    expect(session.stop).toHaveBeenCalled();
  });

  it("silences events from a closed pane", () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    const sink = makeSink();
    registry.attach("pane-1", sink);
    void registry.close("pane-1");
    output(0, 1);
    expect(sink.onOutput).not.toHaveBeenCalled();
  });
});

describe("writePane", () => {
  it("writes through to the live session", async () => {
    registry.acquire("pane-1", SPEC, LAUNCH);
    const session = harness.makeSession();
    harness.spawns[0].resolve(session);
    await settle();
    registry.write("pane-1", "ls\n");
    // A write joins the pane's queue rather than going out on the spot — see
    // `writePane` for why order has to be built here. It reaches the session
    // a turn of the loop later, and never later than that when nothing is
    // ahead of it.
    await settle();
    expect(session.write).toHaveBeenCalledWith("ls\n");
  });

  it("is a no-op for unknown panes and pending spawns", () => {
    expect(() => registry.write("pane-none", "x")).not.toThrow();
    registry.acquire("pane-1", SPEC, LAUNCH);
    expect(() => registry.write("pane-1", "x")).not.toThrow();
  });
});

describe("write ordering", () => {
  /** A session whose writes finish only when the test says so — and the test
   * finishes them LAST first. Two writes in flight at once is the only way an
   * inversion can happen, and it is what the deck used to allow: each write
   * was its own fire-and-forget invoke, and the Rust side takes a writer lock
   * that is not FIFO, so whichever task reached it first won. */
  function hostileSession() {
    const pending: { data: string; done: () => void }[] = [];
    const landed: string[] = [];
    const session = {
      ...harness.makeSession(),
      write: vi.fn(
        (data: string) =>
          new Promise<void>((resolve) => {
            pending.push({
              data,
              done: () => {
                landed.push(data);
                resolve();
              },
            });
          }),
      ),
    };
    return { session, pending, landed };
  }

  it("lands two writes issued in one tick in the order they were issued", async () => {
    // The submit gesture is exactly this shape: the paste, then a bare CR, both
    // out in the same synchronous breath. A CR that overtakes its paste spends
    // itself on an empty composer, and the text then arrives and SITS there —
    // indistinguishable, from up here, from a delivery.
    const { session, pending, landed } = hostileSession();
    registry.acquire("pane-1", SPEC, LAUNCH);
    harness.spawns[0].resolve(session);
    await settle();

    registry.write("pane-1", "the paste");
    registry.write("pane-1", "\r");
    await settle();

    // One at a time is the whole fix: with two in flight the environment
    // decides the order, and this environment decides it badly.
    expect(pending).toHaveLength(1);

    for (let guard = 0; pending.length > 0 && guard < 4; guard += 1) {
      pending.pop()?.done();
      await settle();
    }

    expect(landed).toEqual(["the paste", "\r"]);
  });

  it("drops a queued write when the pane closes instead of sending it late", async () => {
    // The queue must not become a way for a retired session to keep receiving
    // bytes: a close is immediate and the tail goes with it.
    const { session, pending } = hostileSession();
    registry.acquire("pane-1", SPEC, LAUNCH);
    harness.spawns[0].resolve(session);
    await settle();

    registry.write("pane-1", "first");
    registry.write("pane-1", "second");
    await settle();

    await registry.close("pane-1");
    pending.pop()?.done();
    await settle();

    expect(session.write).toHaveBeenCalledTimes(1);
  });
});
