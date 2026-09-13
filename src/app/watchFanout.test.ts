import { describe, expect, it, vi } from "vitest";
import { makeWatchFanout } from "./pluginManager";

/** A fake watcher family: exposes the handler the fanout subscribed with, so a
 * test can push a change the way the backend would.
 *
 * `landed` records the order backend operations COMPLETE in — the subject of
 * the ordering tests. `holdStarts()` makes every `start` hang until released,
 * which is the real-world window (the Rust watch command is async, unwatch is
 * not) a dispose can slip into. */
function fakeBackend() {
  let emit: ((path: string) => void) | undefined;
  const landed: string[] = [];
  const gates: Array<() => void> = [];
  let holding = false;
  return {
    landed,
    fire: (path: string) => emit?.(path),
    holdStarts: () => {
      holding = true;
    },
    releaseStarts: () => {
      holding = false;
      for (const open of gates.splice(0)) open();
    },
    backend: {
      label: "fs",
      subscribe: async (handler: (path: string) => void) => {
        emit = handler;
        return () => {};
      },
      start: vi.fn(async (path: string) => {
        if (holding) await new Promise<void>((r) => gates.push(r));
        landed.push(`start:${path}`);
      }),
      stop: vi.fn(async (path: string) => {
        landed.push(`stop:${path}`);
      }),
    },
  };
}

/** The fanout attaches its backend subscription lazily via a promise chain;
 * let those microtasks run before firing. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("watch fanout", () => {
  it("delivers a change to every subscriber on the path", async () => {
    const { backend, fire } = fakeBackend();
    const watch = makeWatchFanout(backend);
    const first = vi.fn();
    const second = vi.fn();
    watch("/repo", "workspace", first);
    watch("/repo", "workspace", second);
    await settle();

    fire("/repo");

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    // Two subscribers on one path share a single OS watcher.
    expect(backend.start).toHaveBeenCalledTimes(1);
  });

  it("a throwing subscriber does not strand the ones after it", async () => {
    const { backend, fire } = fakeBackend();
    const watch = makeWatchFanout(backend);
    const throws = vi.fn(() => {
      throw new Error("subscriber blew up");
    });
    const after = vi.fn();
    watch("/repo", "workspace", throws);
    watch("/repo", "workspace", after);
    await settle();

    expect(() => fire("/repo")).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("one throwing subscriber does not halt delivery on other paths", async () => {
    const { backend, fire } = fakeBackend();
    const watch = makeWatchFanout(backend);
    watch("/repo", "workspace", () => {
      throw new Error("subscriber blew up");
    });
    const elsewhere = vi.fn();
    watch("/other", "workspace", elsewhere);
    await settle();

    // A single module-lifetime listener feeds the whole family: an error
    // escaping one path's fanout must not take the listener down with it.
    fire("/repo");
    fire("/other");

    expect(elsewhere).toHaveBeenCalledTimes(1);
  });

  it("stops the OS watcher only once the last subscriber leaves", async () => {
    const { backend } = fakeBackend();
    const watch = makeWatchFanout(backend);
    const first = watch("/repo", "workspace", vi.fn());
    const second = watch("/repo", "workspace", vi.fn());
    await settle();

    first.dispose();
    await settle();
    expect(backend.stop).not.toHaveBeenCalled();

    // The stop is queued behind this path's chain rather than fired inline,
    // so it reaches the backend a turn later.
    second.dispose();
    await settle();
    expect(backend.stop).toHaveBeenCalledWith("/repo");
  });

  /** The backend's watch is async and its unwatch is not, so an unchained
   * pair can land out of order. Stop-before-start leaves the OS watcher
   * running with nobody left to close it. */
  it("never stops a watcher the backend has not started yet", async () => {
    const { backend, landed, holdStarts, releaseStarts } = fakeBackend();
    const watch = makeWatchFanout(backend);
    holdStarts();

    const handle = watch("/repo", "workspace", vi.fn());
    handle.dispose();
    releaseStarts();
    await settle();

    expect(landed).toEqual(["start:/repo", "stop:/repo"]);
  });

  /** Subscribe → dispose → subscribe again is StrictMode's mount/cleanup/mount
   * (and any fast toggle). The re-watch's start must be the LAST word, or the
   * late stop kills a watcher that is supposed to be live. */
  it("does not let a late stop undo a re-watch's start", async () => {
    const { backend, landed, holdStarts, releaseStarts } = fakeBackend();
    const watch = makeWatchFanout(backend);
    holdStarts();

    watch("/repo", "workspace", vi.fn()).dispose();
    watch("/repo", "workspace", vi.fn());
    releaseStarts();
    await settle();

    expect(landed).toEqual(["start:/repo", "stop:/repo", "start:/repo"]);
  });

  it("ignores a disposed subscriber", async () => {
    const { backend, fire } = fakeBackend();
    const watch = makeWatchFanout(backend);
    const gone = vi.fn();
    const handle = watch("/repo", "workspace", gone);
    const stays = vi.fn();
    watch("/repo", "workspace", stays);
    await settle();

    handle.dispose();
    fire("/repo");

    expect(gone).not.toHaveBeenCalled();
    expect(stays).toHaveBeenCalledTimes(1);
  });

  /** The backend arms the OS watcher asynchronously, so a refusal (a path
   * outside the roots, a watcher limit) lands AFTER the handle was handed
   * back. It used to be logged and forgotten: the subscriber kept a handle
   * that would never fire and the path kept a callback set, so even a later
   * watch of the same path joined the phantom instead of asking again. */
  it("rejects `ready` when the backend refuses, and lets a later watch ask again", async () => {
    const { backend } = fakeBackend();
    backend.start.mockRejectedValueOnce(new Error("path is outside the workspace"));
    const watch = makeWatchFanout(backend);

    const refused = watch("/repo", "workspace", vi.fn());
    await expect(refused.ready).rejects.toThrow("outside the workspace");

    // The retry is a NEW watch: the backend is asked a second time, and this
    // time the watch is live.
    const again = watch("/repo", "workspace", vi.fn());
    await expect(again.ready).resolves.toBeUndefined();
    expect(backend.start).toHaveBeenCalledTimes(2);

    // Disposing the dead handle neither stops the live watcher nor throws.
    refused.dispose();
    await settle();
    expect(backend.stop).not.toHaveBeenCalled();
  });

  it("gives a subscriber that joins a start still in flight the same `ready`", async () => {
    const { backend, holdStarts, releaseStarts } = fakeBackend();
    backend.start.mockRejectedValueOnce(new Error("no watchers left"));
    const watch = makeWatchFanout(backend);
    holdStarts();

    const first = watch("/repo", "workspace", vi.fn());
    const second = watch("/repo", "workspace", vi.fn());
    releaseStarts();

    // One refusal, heard by both — from the one start made for both.
    await expect(first.ready).rejects.toThrow("no watchers left");
    await expect(second.ready).rejects.toThrow("no watchers left");
    expect(backend.start).toHaveBeenCalledTimes(1);
  });

  it("resolves `ready` once the backend has armed the watch", async () => {
    const { backend, holdStarts, releaseStarts } = fakeBackend();
    const watch = makeWatchFanout(backend);
    holdStarts();

    const handle = watch("/repo", "workspace", vi.fn());
    let armed = false;
    void handle.ready.then(() => {
      armed = true;
    });
    await settle();
    expect(armed).toBe(false);

    releaseStarts();
    await handle.ready;
    expect(armed).toBe(true);
  });
});
