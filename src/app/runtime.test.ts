import { describe, expect, it, vi } from "vitest";
import type { DownloadRequest } from "@keepdeck/plugin-api";
import { createCommandRegistry } from "../domain/commands";
import type { DownloadBackend } from "./downloadManager";
import { createAppRuntime } from "./runtime";
import { stagingTrims } from "./stagingTrims";

/** The artifacts setting, as the runtime reads it: null until loaded, and a
 * flip the test drives. Everything else of the settings owner stays real. */
const artifactsSetting = vi.hoisted(() => {
  let value: boolean | null = null;
  const listeners = new Set<() => void>();
  return {
    read: () => (value === null ? null : { artifacts: value }),
    set(next: boolean) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

vi.mock("./settingsManager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsManager")>()),
  getSettings: artifactsSetting.read,
  subscribeSettings: artifactsSetting.subscribe,
}));

// The artifacts server's IPC, the boundary the claim's transitions cross.
vi.mock("../ipc/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/artifacts")>()),
  artifactsEnable: vi.fn(async () => 43119),
  artifactsDisable: vi.fn(async () => {}),
}));

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const request = (id: string): DownloadRequest => ({
  id,
  source: { url: "https://example.com/artifact" },
  target: { kind: "file", path: `${id}/artifact` },
});

function backend(): DownloadBackend {
  return {
    start: vi.fn(async () => new Promise<void>(() => {})),
    cancel: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    remove: vi.fn(async () => {}),
  };
}

describe("createAppRuntime", () => {
  it("owns an isolated dependency graph instead of a module singleton", () => {
    const firstBackend = backend();
    const secondBackend = backend();
    // Each runtime contributes its commands (mail's, for its whole life) to
    // the registry it is given; two runtimes sharing the process-wide one
    // would collide on the first registration.
    const first = createAppRuntime(firstBackend, createCommandRegistry());
    const second = createAppRuntime(secondBackend, createCommandRegistry());

    expect(first).not.toBe(second);
    expect(first.downloads).not.toBe(second.downloads);
    expect(first.plugins.pluginHost).not.toBe(second.plugins.pluginHost);
    expect(first.plugins.pluginRegistries).not.toBe(
      second.plugins.pluginRegistries,
    );
    expect(first.fileOpen).not.toBe(second.fileOpen);
    expect(first.paneInputFocus).not.toBe(second.paneInputFocus);
    expect(first.paneViewActions).not.toBe(second.paneViewActions);

    // The same active id is legal in another runtime because neither job map
    // nor backend routing leaks through module state.
    first.downloads.start(request("same-id"));
    expect(() => second.downloads.start(request("same-id"))).not.toThrow();
    expect(firstBackend.start).toHaveBeenCalledOnce();
    expect(secondBackend.start).toHaveBeenCalledOnce();

    first.dispose();
    second.dispose();
  });

  it("exposes the session index owner and tears it down with the runtime", () => {
    const runtime = createAppRuntime(backend(), createCommandRegistry());
    // Fresh owner: idle, nothing scanned.
    expect(runtime.sessionIndex.snapshot()).toEqual({
      scanning: false,
      revision: 0,
      invalidated: new Set(),
    });

    // The dispose chain must actually REACH the owner — a dispose that
    // exists only on the manager would be test-only API.
    const original = runtime.sessionIndex.dispose.bind(runtime.sessionIndex);
    const spy = vi.fn(original);
    runtime.sessionIndex.dispose = spy;
    runtime.dispose();
    expect(spy).toHaveBeenCalledOnce();

    // After teardown the owner ignores needs: no throw, no state move.
    runtime.sessionIndex.ensureFresh("claude");
    expect(runtime.sessionIndex.snapshot()).toEqual({
      scanning: false,
      revision: 0,
      invalidated: new Set(),
    });
  });

  it("forgets what staging said under the old artifacts claim when the claim flips", async () => {
    // The claim gates the bundled skills tier, which takes room in a view:
    // what a stage said it could not hand out whole was said under the claim
    // it ran with.
    const runtime = createAppRuntime(backend(), createCommandRegistry());
    stagingTrims.record({ id: "ws-1", instance: "ws-1-life-1", name: "ws-1" }, [
      { scope: "global", skill: "review", kind: "omitted", path: null, count: 1 },
    ]);
    expect(stagingTrims.get()).toHaveLength(1);

    artifactsSetting.set(true);
    await flush();
    expect(stagingTrims.get()).toEqual([]);

    runtime.dispose();
  });
});
