import { describe, expect, it, vi } from "vitest";
import { EMPTY_SPAWN_CONTEXT, type SpawnPlanContext } from "./spawnSpecs";
import { createSpawnContextSource } from "./spawnContextSource";

/** A loader whose promise the test settles by hand. */
function deferred() {
  let resolve!: (ctx: SpawnPlanContext) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<SpawnPlanContext>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let the source's `.catch().then()` chain run. */
const settle = () => Promise.resolve().then().then().then();

describe("createSpawnContextSource", () => {
  it("reads null until the boot load settles — callers must not spawn blind", async () => {
    const { promise, resolve } = deferred();
    const source = createSpawnContextSource(() => promise);
    expect(source.get()).toBeNull();

    resolve({ bridgeDir: "/bridge/run-1" });
    await settle();
    expect(source.get()).toEqual({ bridgeDir: "/bridge/run-1" });
  });

  it("notifies subscribers when the context arrives", async () => {
    const { promise, resolve } = deferred();
    const source = createSpawnContextSource(() => promise);
    const listener = vi.fn();
    source.subscribe(listener);

    resolve({ bridgeDir: "/bridge/run-1" });
    await settle();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("degrades a FAILED load to the empty context instead of staying null", async () => {
    // Staying null would freeze the deck's first paint forever: the gate reads
    // "still loading", and nothing else is coming.
    const { promise, reject } = deferred();
    const source = createSpawnContextSource(() => promise);
    const listener = vi.fn();
    source.subscribe(listener);

    reject(new Error("no host"));
    await settle();
    expect(source.get()).toEqual(EMPTY_SPAWN_CONTEXT);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops notifying an unsubscribed listener", async () => {
    const { promise, resolve } = deferred();
    const source = createSpawnContextSource(() => promise);
    const listener = vi.fn();
    source.subscribe(listener)();

    resolve({ bridgeDir: "/bridge/run-1" });
    await settle();
    expect(listener).not.toHaveBeenCalled();
  });
});
