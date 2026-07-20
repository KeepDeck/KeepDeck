import { describe, expect, it, vi } from "vitest";
import {
  createFakeHost,
  fakeManifest,
} from "../../../packages/plugin-guest/src/fakeHost";
import { createBindingsStore } from "./bindingsStore";
import { DEFAULT_BINDINGS, HOTKEYS_KEY, type Chord } from "./binding";

/** Let the async settings.read().then(apply) microtask settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const customBag = (command: Partial<Chord>, dictation: Partial<Chord>) => ({
  [HOTKEYS_KEY]: {
    command: { code: "Space", alt: false, shift: false, ctrl: false, meta: false, ...command },
    dictation: { code: "Space", alt: false, shift: false, ctrl: false, meta: false, ...dictation },
  },
});

describe("createBindingsStore", () => {
  it("stands on the shipped defaults until the first read resolves", async () => {
    const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
    const store = createBindingsStore(host.ctx);
    expect(store.get()).toEqual(DEFAULT_BINDINGS);
    await flush();
    expect(store.get()).toEqual(DEFAULT_BINDINGS);
  });

  it("seeds from the persisted settings values", async () => {
    const host = createFakeHost({
      manifest: fakeManifest("keepdeck.voice"),
      settingsValues: customBag({ code: "KeyG", ctrl: true }, { code: "KeyH", ctrl: true }),
    });
    const store = createBindingsStore(host.ctx);
    await flush();
    expect(store.get().command).toEqual({
      code: "KeyG",
      alt: false,
      shift: false,
      ctrl: true,
      meta: false,
    });
  });

  it("updates live and notifies when settings change", async () => {
    const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
    const store = createBindingsStore(host.ctx);
    await flush();
    const listener = vi.fn();
    store.subscribe(listener);

    host.fire.settingsChanged(customBag({ code: "KeyM", meta: true }, { code: "KeyN", meta: true }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get().command).toEqual({
      code: "KeyM",
      alt: false,
      shift: false,
      ctrl: false,
      meta: true,
    });
  });

  it("stops tracking after dispose", async () => {
    const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
    const store = createBindingsStore(host.ctx);
    await flush();
    store.dispose();

    host.fire.settingsChanged(customBag({ code: "KeyM", meta: true }, { code: "KeyN", meta: true }));

    expect(store.get()).toEqual(DEFAULT_BINDINGS);
    expect(host.unsubscribes.settingsChanged).toBe(1);
  });
});
