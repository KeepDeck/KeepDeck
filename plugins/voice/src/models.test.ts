import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import { createFakeHost, fakeManifest } from "../../../packages/plugin-guest/src/fakeHost";
import { createModelsStore } from "./models";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(installed: () => boolean) {
  const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
  const exists = vi.fn(async () => installed());
  const ctx: PluginContext = {
    ...host.ctx,
    services: {
      ...host.ctx.services,
      downloads: { ...host.ctx.services.downloads, exists },
      speech: { ...host.ctx.services.speech, engines: async () => ["whisper"] },
    },
  };
  return { ctx, exists };
}

describe("voice model store", () => {
  it("combines the plugin catalog with generic installed state", async () => {
    const { ctx } = setup(() => true);
    const store = createModelsStore(ctx);
    expect(store.snapshot()).toBeNull();
    await tick();
    expect(store.snapshot()?.every((model) => model.engine === "whisper")).toBe(true);
    expect(store.snapshot()?.every((model) => model.installed)).toBe(true);
  });

  it("refresh re-checks artifacts and notifies subscribers", async () => {
    let installed = true;
    const { ctx } = setup(() => installed);
    const store = createModelsStore(ctx);
    await tick();
    const listener = vi.fn();
    store.subscribe(listener);
    installed = false;
    await store.refresh();
    expect(store.snapshot()?.every((model) => !model.installed)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("keeps the last good list when a later read fails", async () => {
    const { ctx } = setup(() => true);
    const store = createModelsStore(ctx);
    await tick();
    ctx.services.downloads.exists = vi.fn(async () => {
      throw new Error("read failed");
    });
    await store.refresh();
    expect(store.error()).toBe("read failed");
    expect(store.snapshot()?.length).toBeGreaterThan(0);
  });

  it("does not let an older refresh overwrite a newer snapshot", async () => {
    const { ctx } = setup(() => true);
    let first!: (engines: ("whisper" | "parakeet")[]) => void;
    let second!: (engines: ("whisper" | "parakeet")[]) => void;
    const firstResult = new Promise<("whisper" | "parakeet")[]>((resolve) => {
      first = resolve;
    });
    const secondResult = new Promise<("whisper" | "parakeet")[]>((resolve) => {
      second = resolve;
    });
    ctx.services.speech.engines = vi
      .fn()
      .mockReturnValueOnce(firstResult)
      .mockReturnValueOnce(secondResult);
    const store = createModelsStore(ctx);
    const latest = store.refresh();
    second(["whisper"]);
    await latest;
    first(["parakeet"]);
    await tick();
    expect(store.snapshot()?.every((model) => model.engine === "whisper")).toBe(true);
  });
});
