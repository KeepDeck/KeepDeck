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

/** A host with the hotkeys field declared, exactly as `activate` declares it:
 * a plugin is handed a stored value only through a registered section, and
 * only under a key that section names. */
function voiceHost(settingsValues?: Record<string, unknown>) {
  const host = createFakeHost({
    manifest: fakeManifest("keepdeck.voice"),
    settingsValues,
  });
  host.ctx.settings.registerSection({
    label: "Voice",
    fields: [{ kind: "custom", key: HOTKEYS_KEY, Component: () => null }],
  });
  return host;
}

describe("createBindingsStore", () => {
  it("stands on the shipped defaults until the read resolves", async () => {
    const host = voiceHost();
    const store = createBindingsStore(host.ctx);
    expect(store.get()).toEqual(DEFAULT_BINDINGS);
    store.load();
    await flush();
    expect(store.get()).toEqual(DEFAULT_BINDINGS);
  });

  it("ignores settings changes until it is loaded", () => {
    const host = voiceHost();
    const store = createBindingsStore(host.ctx);

    host.fire.settingsChanged(customBag({ code: "KeyM", meta: true }, { code: "KeyN", meta: true }));

    expect(store.get()).toEqual(DEFAULT_BINDINGS);
  });

  it("seeds from the persisted settings values", async () => {
    const host = voiceHost(
      customBag({ code: "KeyG", ctrl: true }, { code: "KeyH", ctrl: true }),
    );
    const store = createBindingsStore(host.ctx);
    store.load();
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
    const host = voiceHost();
    const store = createBindingsStore(host.ctx);
    store.load();
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

  it("re-loading replaces the subscription instead of stacking one", async () => {
    const host = voiceHost();
    const store = createBindingsStore(host.ctx);
    store.load();
    store.load();
    await flush();
    const listener = vi.fn();
    store.subscribe(listener);

    host.fire.settingsChanged(customBag({ code: "KeyM", meta: true }, { code: "KeyN", meta: true }));

    expect(listener).toHaveBeenCalledTimes(1);
    // The real check: BOTH subscriptions are accounted for — the first was
    // released by the second load, the second by dispose. Leave one behind and
    // the host still holds a live callback into a store nobody owns (and the
    // host, unlike this fake's callback set, wraps each subscription
    // separately, so it would apply every later change twice).
    store.dispose();
    expect(host.unsubscribes.settingsChanged).toBe(2);
  });

  it("stops tracking after dispose", async () => {
    const host = voiceHost();
    const store = createBindingsStore(host.ctx);
    store.load();
    await flush();
    store.dispose();

    host.fire.settingsChanged(customBag({ code: "KeyM", meta: true }, { code: "KeyN", meta: true }));

    expect(store.get()).toEqual(DEFAULT_BINDINGS);
    expect(host.unsubscribes.settingsChanged).toBe(1);
  });
});
