import type { SpawnContextDto } from "../ipc/sessions";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_SPAWN_CONTEXT } from "./spawnSpecs";
import { createSpawnContextSource } from "./spawnContextSource";

/** A loader whose promise the test settles by hand. The loader answers the
 * DTO half only — the per-pane inbox is a call the source composes in. */
function deferred() {
  let resolve!: (ctx: SpawnContextDto) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<SpawnContextDto>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The per-pane inbox port, stubbed. */
const perPaneDir = (paneId: string) => Promise.resolve(`/bridge/run-1/${paneId}`);

/** Let the source's `.catch().then()` chain run. */
const settle = () => Promise.resolve().then().then().then();

describe("createSpawnContextSource", () => {
  it("reads null until the boot load settles — callers must not spawn blind", async () => {
    const { promise, resolve } = deferred();
    const source = createSpawnContextSource(() => promise, perPaneDir);
    expect(source.get()).toBeNull();

    resolve({ bridgeDir: "/bridge/run-1", bridgePort: 51000 });
    await settle();
    expect(source.get()?.bridgeDir).toBe("/bridge/run-1");
    // The per-pane inbox rides along as a call, so a plan built from this
    // context can create the directory it is about to hand an agent.
    await expect(source.get()?.paneBridgeDir("pane-3")).resolves.toBe(
      "/bridge/run-1/pane-3",
    );
  });

  it("notifies subscribers when the context arrives", async () => {
    const { promise, resolve } = deferred();
    const source = createSpawnContextSource(() => promise, perPaneDir);
    const listener = vi.fn();
    source.subscribe(listener);

    resolve({ bridgeDir: "/bridge/run-1", bridgePort: 51000 });
    await settle();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("degrades a FAILED load to the empty context instead of staying null", async () => {
    // Staying null would freeze the deck's first paint forever: the gate reads
    // "still loading", and nothing else is coming.
    const { promise, reject } = deferred();
    const source = createSpawnContextSource(() => promise, perPaneDir);
    const listener = vi.fn();
    source.subscribe(listener);

    reject(new Error("no host"));
    await settle();
    expect(source.get()).toEqual(EMPTY_SPAWN_CONTEXT);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops notifying an unsubscribed listener", async () => {
    const { promise, resolve } = deferred();
    const source = createSpawnContextSource(() => promise, perPaneDir);
    const listener = vi.fn();
    source.subscribe(listener)();

    resolve({ bridgeDir: "/bridge/run-1", bridgePort: 51000 });
    await settle();
    expect(listener).not.toHaveBeenCalled();
  });
});
