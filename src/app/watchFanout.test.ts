import { describe, expect, it, vi } from "vitest";
import { makeWatchFanout } from "./pluginManager";

/** A fake watcher family: exposes the handler the fanout subscribed with, so a
 * test can push a change the way the backend would. */
function fakeBackend() {
  let emit: ((path: string) => void) | undefined;
  return {
    fire: (path: string) => emit?.(path),
    backend: {
      label: "fs",
      subscribe: async (handler: (path: string) => void) => {
        emit = handler;
        return () => {};
      },
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
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
    expect(backend.stop).not.toHaveBeenCalled();
    second.dispose();
    expect(backend.stop).toHaveBeenCalledWith("/repo");
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
});
