// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeHost,
  fakeManifest,
  type FakeHost,
} from "../../../packages/plugin-guest/src/fakeHost";
// The contract's own merge — the exact seam a custom field's value has to
// survive to reach the plugin.
import { mergeSectionValues } from "@keepdeck/plugin-api";
import plugin from "./index";
import { runtime } from "./runtime";
import { MODEL_KEY } from "./controller";
import { DEFAULT_BINDINGS, HOTKEYS_KEY, parseBindings } from "./binding";

let host: FakeHost | null = null;

/** Let the async settings.read().then(...) microtask settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(async () => {
  await plugin.deactivate?.();
  host = null;
});

function activate(settingsValues?: Record<string, unknown>): FakeHost {
  host = createFakeHost({
    manifest: fakeManifest("keepdeck.voice"),
    settingsValues,
  });
  void plugin.activate(host.ctx);
  return host;
}

describe("voice plugin activation", () => {
  it("declares a field for EVERY key the plugin reads and writes", () => {
    const h = activate();
    const section = h.settingsSections[0];
    expect(section?.label).toBe("Voice");
    // The host serves a plugin only the keys its section declares, so every
    // constant the plugin persists under must appear here — a key that drifts
    // from its constant is a value that silently never comes back.
    expect(section.fields.map((f) => f.key).sort()).toEqual(
      [HOTKEYS_KEY, MODEL_KEY].sort(),
    );
    expect(section.fields.every((f) => f.kind === "custom")).toBe(true);
    // The dock tab and pill are wired too.
    expect(h.dockTabs.map((t) => t.id)).toContain("voice");
    expect(h.overlays.map((o) => o.id)).toContain("pill");
  });

  it("a saved model pick survives the real host merge", () => {
    const h = activate();
    const section = h.settingsSections[0];
    // What ModelsSection persists (write(MODEL_KEY, id)) must be what the
    // controller reads back out of ctx.settings.read() at capture time.
    const merged = mergeSectionValues(section, { [MODEL_KEY]: "whisper-small" });
    expect(merged[MODEL_KEY]).toBe("whisper-small");
  });

  it("a saved chord survives the real host merge and loads via parseBindings", () => {
    const h = activate();
    const section = h.settingsSections[0];
    const saved = {
      [HOTKEYS_KEY]: {
        command: { code: "KeyJ", alt: false, shift: false, ctrl: true, meta: true },
        dictation: DEFAULT_BINDINGS.dictation,
      },
    };
    // The host's read path runs stored values through mergeSectionValues.
    const merged = mergeSectionValues(section, saved);
    expect(merged[HOTKEYS_KEY]).toEqual(saved[HOTKEYS_KEY]);
    expect(parseBindings(merged).command).toEqual({
      code: "KeyJ",
      alt: false,
      shift: false,
      ctrl: true,
      meta: true,
    });
  });

  it("puts the persisted chords in the live store, not the shipped defaults", async () => {
    // The user's own binding: the two shipped chords, swapped.
    const saved = {
      [HOTKEYS_KEY]: {
        command: { code: "Space", alt: true, shift: true, ctrl: false, meta: false },
        dictation: { code: "Space", alt: true, shift: false, ctrl: false, meta: false },
      },
    };
    activate(saved);
    await flush();
    // Seeding the store before the section is declared reads an empty bag, and
    // nothing writes settings at boot to correct it — so every launch would run
    // push-to-talk on the defaults while settings.json held these.
    expect(runtime().bindings.get()).toEqual(saved[HOTKEYS_KEY]);
  });

  it("disposes the bindings subscription on deactivate", async () => {
    const h = activate();
    await plugin.deactivate?.();
    host = null; // already torn down; keep afterEach idempotent
    expect(h.unsubscribes.settingsChanged).toBe(1);
  });
});
