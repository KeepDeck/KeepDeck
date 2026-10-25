// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_KEY } from "../modelChoice";
import { MODEL_CATALOG, type VoiceModelInfo } from "../modelCatalog";
import {
  createFakeHost,
  fakeManifest,
} from "../../../../packages/plugin-guest/src/fakeHost";
import { createBindingsStore } from "../bindingsStore";
import { createRecordingLatch } from "../recordingLatch";
import { clearRuntime, setRuntime } from "../runtime";
import { controllerOf, downloadsOf, modelsOf } from "../voiceFakes.test-support";
import { ModelsSection } from "./ModelsSection";
import { present } from "@keepdeck/plugin-api/testing";

const installed = (id: string): VoiceModelInfo => ({
  ...present(MODEL_CATALOG.find((model) => model.id === id), "the matching item"),
  installed: true,
});

describe("ModelsSection", () => {
  let stage: HTMLElement;
  let root: Root;
  const write = vi.fn();
  const remove = vi.fn((_model: VoiceModelInfo) => Promise.resolve());

  // Stable snapshots: useSyncExternalStore re-renders on every new object.
  const noDownloads = { active: {}, errors: {}, interrupted: {} };
  const noRemoveErrors = {};

  beforeEach(() => {
    write.mockClear();
    remove.mockClear();
    const models = [installed("whisper-small"), installed("parakeet-tdt-0.6b-v3")];
    const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
    setRuntime({
      ctx: host.ctx,
      controller: controllerOf(),
      downloads: downloadsOf({
        snapshot: () => noDownloads,
        start: vi.fn(async () => true),
        cancel: vi.fn(),
      }),
      models: modelsOf({
        snapshot: () => models,
        removeErrors: () => noRemoveErrors,
        remove,
        current: () => Promise.resolve(models),
      }),
      bindings: createBindingsStore(host.ctx),
      recordingLatch: createRecordingLatch(),
    });
    stage = document.body.appendChild(document.createElement("div"));
    root = createRoot(stage);
    act(() =>
      root.render(
        createElement(ModelsSection, {
          values: { [MODEL_KEY]: "whisper-small" },
          write,
        }),
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    clearRuntime();
    document.body.innerHTML = "";
  });

  const card = (name: RegExp) =>
    present([...stage.querySelectorAll<HTMLElement>(".voice-models__card")].find((el) =>
      name.test(el.textContent ?? ""),
    ), "the matching item");
  const click = (el: Element) =>
    act(() => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

  it("picks an installed model when its card is clicked", () => {
    click(card(/Parakeet/i));
    expect(write).toHaveBeenCalledWith(MODEL_KEY, "parakeet-tdt-0.6b-v3");
  });

  it("still picks from the card's size — only its actions are contained", () => {
    const size = present([...card(/Parakeet/i).querySelectorAll(".voice-models__foot-right > span")].find(
      (span) => /MB$/.test(span.textContent ?? ""),
    ), "the .voice-models__foot-right > span elements");
    click(size);
    expect(write).toHaveBeenCalledWith(MODEL_KEY, "parakeet-tdt-0.6b-v3");
  });

  it("deletes without also picking the model it is deleting", () => {
    const deleteButton = present([...card(/Parakeet/i).querySelectorAll("button")].find(
      (button) => button.textContent === "Delete",
    ), "the button elements");
    click(deleteButton);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][0]).toMatchObject({ id: "parakeet-tdt-0.6b-v3" });
    expect(write).not.toHaveBeenCalled();
  });

  it("an installed card can be chosen from the keyboard", () => {
    const parakeet = card(/Parakeet/i);
    expect(parakeet.tabIndex).toBe(0);
    act(() => {
      parakeet.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(write).toHaveBeenCalledWith(MODEL_KEY, "parakeet-tdt-0.6b-v3");
  });
});
