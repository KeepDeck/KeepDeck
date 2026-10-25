// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeHost,
  fakeManifest,
} from "../../../../packages/plugin-guest/src/fakeHost";
import { createBindingsStore } from "../bindingsStore";
import { createRecordingLatch, type RecordingLatch } from "../recordingLatch";
import { clearRuntime, setRuntime } from "../runtime";
import { controllerOf, downloadsOf, modelsOf } from "../voiceFakes.test-support";
import { HOTKEYS_KEY } from "../binding";
import { HotkeysSection } from "./HotkeysSection";
import { elementOf, elementsOf } from "@keepdeck/plugin-api/testing";

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Fire a key through the window capture phase, as the recorder listens. */
function pressKey(init: KeyboardEventInit): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

describe("HotkeysSection", () => {
  let stage: HTMLElement;
  let root: Root;
  let latch: RecordingLatch;
  let write: ReturnType<typeof vi.fn>;
  let persisted: Record<string, unknown>;

  beforeEach(async () => {
    document.body.innerHTML = "";
    stage = document.createElement("div");
    document.body.appendChild(stage);
    root = createRoot(stage);

    persisted = {};
    const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
    // Declared as `activate` declares it — the host round-trips a plugin's
    // values only under the keys its own section names.
    host.ctx.settings.registerSection({
      label: "Voice",
      fields: [{ kind: "custom", key: HOTKEYS_KEY, Component: () => null }],
    });
    const store = createBindingsStore(host.ctx);
    await flush();
    latch = createRecordingLatch();
    // A write round-trips through the host: persist, then echo the change back
    // so the store (and the rendered row) update exactly as they do live.
    write = vi.fn((key: string, value: unknown) => {
      persisted = { ...persisted, [key]: value };
      act(() => host.fire.settingsChanged(persisted));
    });
    setRuntime({
      ctx: host.ctx,
      controller: controllerOf(),
      downloads: downloadsOf(),
      models: modelsOf(),
      bindings: store,
      recordingLatch: latch,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    clearRuntime();
  });

  const render = () =>
    act(() =>
      root.render(createElement(HotkeysSection, { values: persisted, write })),
    );

  const chordButtons = () =>
    elementsOf(stage, ".voice-hotkeys__chord", HTMLElement);

  it("shows the two default chords", () => {
    render();
    const [command, dictation] = chordButtons();
    expect(command.textContent).toBe("⌥Space");
    expect(dictation.textContent).toBe("⌥⇧Space");
  });

  it("records a new chord, persists it, and updates the row", () => {
    render();
    click(chordButtons()[0]);
    expect(chordButtons()[0].textContent).toBe("Press keys…");
    expect(latch.active()).toBe(true);

    pressKey({ code: "KeyJ", key: "j", ctrlKey: true, metaKey: true });

    expect(write).toHaveBeenCalledWith(HOTKEYS_KEY, {
      command: { code: "KeyJ", alt: false, shift: false, ctrl: true, meta: true },
      dictation: { code: "Space", alt: true, shift: true, ctrl: false, meta: false },
    });
    expect(chordButtons()[0].textContent).toBe("⌃⌘J");
    expect(latch.active()).toBe(false);
  });

  it("blocks a chord identical to the other slot, staying in recording", () => {
    render();
    click(chordButtons()[0]); // record Command
    // Press the dictation chord ⌥⇧Space — a duplicate.
    pressKey({ code: "Space", key: " ", altKey: true, shiftKey: true });

    expect(write).not.toHaveBeenCalled();
    expect(chordButtons()[0].textContent).toBe("Press keys…"); // still recording
    expect(stage.querySelector(".voice-hotkeys__error")?.textContent).toMatch(
      /different/,
    );
  });

  it("Escape cancels recording without binding it", () => {
    render();
    click(chordButtons()[0]);
    pressKey({ code: "Escape", key: "Escape" });

    expect(write).not.toHaveBeenCalled();
    expect(chordButtons()[0].textContent).toBe("⌥Space"); // back to the chord
    expect(latch.active()).toBe(false);
  });

  it("cancels recording when the pointer presses outside the editor", () => {
    render();
    click(chordButtons()[0]);
    expect(chordButtons()[0].textContent).toBe("Press keys…");
    // A press on the settings nav (outside .voice-hotkeys) abandons recording.
    act(() => {
      document.body.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
      );
    });
    expect(write).not.toHaveBeenCalled();
    expect(chordButtons()[0].textContent).toBe("⌥Space");
    expect(latch.active()).toBe(false);
  });

  it("warns, but still binds, a chord with no ⌥/⌃/⌘ modifier", () => {
    render();
    click(chordButtons()[0]);
    pressKey({ code: "KeyB", key: "b" });

    expect(write).toHaveBeenCalledOnce();
    expect(chordButtons()[0].textContent).toBe("B");
    expect(stage.querySelector(".voice-hotkeys__warn")?.textContent).toMatch(
      /shadow/,
    );
  });

  it("resets a slot to its default", () => {
    render();
    click(chordButtons()[0]);
    pressKey({ code: "KeyJ", key: "j", ctrlKey: true, metaKey: true });
    expect(chordButtons()[0].textContent).toBe("⌃⌘J");

    const reset = elementOf(stage, ".voice-hotkeys__reset", HTMLElement);
    click(reset);
    expect(chordButtons()[0].textContent).toBe("⌥Space");
  });
});
