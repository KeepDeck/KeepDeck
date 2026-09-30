// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_KEY } from "../controller";
import { MODEL_CATALOG, type VoiceModelInfo } from "../modelCatalog";
import { clearRuntime, setRuntime, type VoiceRuntime } from "../runtime";
import { ModelsSection } from "./ModelsSection";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const installed = (id: string): VoiceModelInfo => ({
  ...MODEL_CATALOG.find((model) => model.id === id)!,
  installed: true,
});

describe("ModelsSection", () => {
  let stage: HTMLElement;
  let root: Root;
  const write = vi.fn();
  const remove = vi.fn(() => Promise.resolve());

  // Stable snapshots: useSyncExternalStore re-renders on every new object.
  const noDownloads = { active: {}, errors: {} };

  beforeEach(() => {
    write.mockClear();
    remove.mockClear();
    const models = [installed("whisper-small"), installed("parakeet-tdt-0.6b-v3")];
    setRuntime({
      ctx: { services: { downloads: { remove } }, log: { warn: vi.fn() } },
      downloads: {
        snapshot: () => noDownloads,
        subscribe: () => () => {},
        start: vi.fn(),
        cancel: vi.fn(),
        anyActive: () => false,
      },
      models: {
        snapshot: () => models,
        subscribe: () => () => {},
        error: () => null,
        refresh: () => Promise.resolve(),
        current: () => Promise.resolve(models),
      },
    } as unknown as VoiceRuntime);
    stage = document.body.appendChild(document.createElement("div"));
    root = createRoot(stage);
    act(() =>
      root.render(
        createElement(ModelsSection, {
          values: { [MODEL_KEY]: "whisper-small" },
          write,
        } as never),
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    clearRuntime();
    document.body.innerHTML = "";
  });

  const card = (name: RegExp) =>
    [...stage.querySelectorAll<HTMLElement>(".voice-models__card")].find((el) =>
      name.test(el.textContent ?? ""),
    )!;
  const click = (el: Element) =>
    act(() => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

  it("picks an installed model when its card is clicked", () => {
    click(card(/Parakeet/i));
    expect(write).toHaveBeenCalledWith(MODEL_KEY, "parakeet-tdt-0.6b-v3");
  });

  it("still picks from the card's size — only its actions are contained", () => {
    const size = [...card(/Parakeet/i).querySelectorAll(".voice-models__foot-right > span")].find(
      (span) => /MB$/.test(span.textContent ?? ""),
    )!;
    click(size);
    expect(write).toHaveBeenCalledWith(MODEL_KEY, "parakeet-tdt-0.6b-v3");
  });

  it("deletes without also picking the model it is deleting", () => {
    const deleteButton = [...card(/Parakeet/i).querySelectorAll("button")].find(
      (button) => button.textContent === "Delete",
    )!;
    click(deleteButton);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });
});
