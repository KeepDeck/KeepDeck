import { describe, expect, it, vi } from "vitest";
import type { PluginContext, VoiceModelInfo } from "@keepdeck/plugin-api";
import {
  createFakeHost,
  fakeManifest,
} from "../../../packages/plugin-guest/src/fakeHost";
import { createModelsStore } from "./models";

const model = (over: Partial<VoiceModelInfo>): VoiceModelInfo => ({
  id: "m",
  label: "M",
  sizeMb: 100,
  installed: false,
  retired: false,
  ...over,
});

function setup(lists: VoiceModelInfo[][]) {
  const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
  let call = 0;
  const models = vi.fn(async () => lists[Math.min(call++, lists.length - 1)]);
  const ctx: PluginContext = {
    ...host.ctx,
    services: { ...host.ctx.services, voice: { ...host.ctx.services.voice, models } },
  };
  return { ctx, models };
}

/** Flush the store's fire-and-forget initial refresh. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createModelsStore", () => {
  it("loads on creation and reflects the list", async () => {
    const { ctx } = setup([[model({ id: "a", installed: true })]]);
    const store = createModelsStore(ctx);
    expect(store.snapshot()).toBeNull(); // not loaded yet
    await tick();
    expect(store.snapshot()).toEqual([model({ id: "a", installed: true })]);
    expect(store.error()).toBeNull();
  });

  it("refresh re-reads and notifies subscribers", async () => {
    const { ctx } = setup([
      [model({ id: "a", installed: true })],
      [model({ id: "a", installed: false })],
    ]);
    const store = createModelsStore(ctx);
    await tick();
    const seen: (boolean | undefined)[] = [];
    store.subscribe(() => seen.push(store.snapshot()?.[0]?.installed));
    await store.refresh();
    expect(store.snapshot()?.[0]?.installed).toBe(false);
    expect(seen).toEqual([false]);
  });

  it("keeps the last list and records the error on a failed read", async () => {
    const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
    let ok = true;
    const ctx: PluginContext = {
      ...host.ctx,
      services: {
        ...host.ctx.services,
        voice: {
          ...host.ctx.services.voice,
          models: vi.fn(async () => {
            if (!ok) throw new Error("read failed");
            return [model({ id: "a", installed: true })];
          }),
        },
      },
    };
    const store = createModelsStore(ctx);
    await tick();
    ok = false;
    await store.refresh();
    expect(store.error()).toBe("read failed");
    // The last good list survives so the UI doesn't blank on a transient error.
    expect(store.snapshot()?.[0]?.id).toBe("a");
  });
});
