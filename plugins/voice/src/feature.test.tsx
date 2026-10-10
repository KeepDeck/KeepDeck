// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createFakeHost, fakeManifest } from "../../../packages/plugin-guest/src/fakeHost";
import { startVoiceFeature } from "./feature";
import { runtime } from "./runtime";

describe("startVoiceFeature", () => {
  it("dispose takes everything down: hotkeys, the runtime, a capture in flight", async () => {
    const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
    const feature = startVoiceFeature(host.ctx);
    const { controller } = runtime();
    const cancel = vi.spyOn(controller, "cancel");
    const start = vi.spyOn(controller, "start").mockResolvedValue();
    const chord = () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", altKey: true }));
    chord();
    expect(start).toHaveBeenCalledOnce(); // the default command chord is live

    await feature.dispose();

    expect(cancel).toHaveBeenCalledOnce();
    expect(() => runtime()).toThrow(/not active/);
    chord();
    expect(start).toHaveBeenCalledOnce(); // …and gone after dispose
  });

  it("dispose twice is harmless", async () => {
    const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
    const feature = startVoiceFeature(host.ctx);
    await feature.dispose();
    await expect(feature.dispose()).resolves.toBeUndefined();
  });
});
