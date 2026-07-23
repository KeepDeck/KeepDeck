// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeHost,
  fakeManifest,
} from "../../../../packages/plugin-guest/src/fakeHost";
import { createBindingsStore } from "../bindingsStore";
import { clearRuntime, setRuntime } from "../runtime";
import type { VoiceController, VoiceSnapshot } from "../controller";
import type { ModelDownloads } from "../downloads";
import type { ModelsStore } from "../models";
import { VoiceTab } from "./VoiceTab";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A snapshot with two history rows of different tones. */
function snapshotWithHistory(): VoiceSnapshot {
  return {
    phase: "idle",
    mode: null,
    level: 0,
    history: [
      { at: 1, tone: "heard", text: "привет" },
      { at: 2, tone: "done", text: "готово" },
    ],
  };
}

describe("VoiceTab history click-to-copy", () => {
  let stage: HTMLElement;
  let root: Root;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    document.body.innerHTML = "";
    stage = document.createElement("div");
    document.body.appendChild(stage);
    root = createRoot(stage);

    const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
    await flush();

    // Spy the clipboard write — the single thing this feature does.
    writeText = vi.fn(async (_text: string) => {});
    host.ctx.services.clipboard.writeText = writeText;

    const snap = snapshotWithHistory();
    const controller = {
      snapshot: () => snap,
      subscribe: () => () => {},
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      clearHistory: vi.fn(),
      cancel: vi.fn(async () => {}),
    } as unknown as VoiceController;
    const modelsSnap = [{ installed: true }] as never;
    const models = {
      snapshot: () => modelsSnap,
      subscribe: () => () => {},
    } as unknown as ModelsStore;
    const dlSnap = { active: {} };
    const downloads = {
      snapshot: () => dlSnap,
      subscribe: () => () => {},
    } as unknown as ModelDownloads;

    setRuntime({
      ctx: host.ctx,
      controller,
      downloads,
      models,
      bindings: createBindingsStore(host.ctx),
      recordingLatch: undefined as never,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    clearRuntime();
  });

  const render = () => act(() => root.render(createElement(VoiceTab)));
  const entries = () =>
    [...stage.querySelectorAll(".voice__entry")] as HTMLElement[];

  it("clicking a row copies its text and flashes the copied state", async () => {
    render();
    const [first] = entries();
    expect(first.querySelector(".voice__text")?.textContent).toBe("привет");

    await act(async () => {
      first.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await flush();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toBe("привет");
    // The row's text is briefly replaced by "Copied"; the tone glyph stays put.
    expect(first.querySelector(".voice__text")?.textContent).toBe("Copied");
    expect(first.querySelector(".voice__tone")?.textContent).toBe("🗣");
    expect(first.className).toContain("voice__entry--copied");
  });

  it("Enter and Space both copy (keyboard parity)", async () => {
    render();
    const [, second] = entries();

    for (const key of ["Enter", " "]) {
      await act(async () => {
        second.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
        await flush();
      });
    }

    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText.mock.calls.every((call) => call[0] === "готово")).toBe(true);
  });

  it("does not copy when the click ends a text selection (manual copy fallback)", async () => {
    render();
    // Simulate an active drag-selection: getSelection returns non-empty text.
    const selectionSpy = vi
      .spyOn(window, "getSelection")
      .mockReturnValue({ toString: () => "selected" } as unknown as Selection);

    await act(async () => {
      entries()[0].dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await flush();
    });

    expect(writeText).not.toHaveBeenCalled();
    selectionSpy.mockRestore();
  });
});
