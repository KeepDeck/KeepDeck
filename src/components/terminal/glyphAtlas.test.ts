// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
import { recordingContext2d, stubCanvasContext } from "../canvasContext.test-support";
import { GLYPH_ATLAS_PAGES_KEPT, capGlyphAtlas } from "./glyphAtlas";

/** The addon's atlas surface, driven by hand: pages arrive when the test says. */
function renderer() {
  const listeners: ((page: HTMLCanvasElement) => void)[] = [];
  const surface = {
    textureAtlas: document.createElement("canvas") as HTMLCanvasElement | undefined,
    clearTextureAtlas: vi.fn(),
    onAddTextureAtlasCanvas: (listener: (page: HTMLCanvasElement) => void) => {
      listeners.push(listener);
      return { dispose: () => {} };
    },
  };
  const addPages = (count: number) => {
    for (let i = 0; i < count; i++) {
      const page = document.createElement("canvas");
      for (const listener of listeners) listener(page);
    }
  };
  return { surface, addPages };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the glyph atlas cap", () => {
  it("lets the atlas grow to its cap untouched", () => {
    const { surface, addPages } = renderer();
    capGlyphAtlas(surface);
    // The first page is the one the atlas was born with.
    addPages(GLYPH_ATLAS_PAGES_KEPT - 1);
    vi.runAllTimers();
    expect(surface.clearTextureAtlas).not.toHaveBeenCalled();
  });

  it("clears it once a page lands past the cap — after the frame that added it", () => {
    const { surface, addPages } = renderer();
    capGlyphAtlas(surface);
    addPages(GLYPH_ATLAS_PAGES_KEPT);
    expect(surface.clearTextureAtlas).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(surface.clearTextureAtlas).toHaveBeenCalledTimes(1);
  });

  it("clears once for pages that land together, and again for the next one past the cap", () => {
    const { surface, addPages } = renderer();
    capGlyphAtlas(surface);
    addPages(GLYPH_ATLAS_PAGES_KEPT + 3);
    vi.runAllTimers();
    expect(surface.clearTextureAtlas).toHaveBeenCalledTimes(1);
    // A cleared atlas keeps its pages: the next new one is still past the cap.
    addPages(1);
    vi.runAllTimers();
    expect(surface.clearTextureAtlas).toHaveBeenCalledTimes(2);
  });

  it("starts a new atlas's count from its own first page", () => {
    const { surface, addPages } = renderer();
    capGlyphAtlas(surface);
    addPages(GLYPH_ATLAS_PAGES_KEPT - 1);
    // A theme or pixel-ratio change: the old pages went with the old atlas.
    surface.textureAtlas = document.createElement("canvas");
    addPages(GLYPH_ATLAS_PAGES_KEPT - 1);
    vi.runAllTimers();
    expect(surface.clearTextureAtlas).not.toHaveBeenCalled();
  });
});

describe("the canvas renderer under the cap", () => {
  let restoreCanvas: () => void;

  beforeEach(() => {
    const drawn: unknown[] = [];
    restoreCanvas = stubCanvasContext((canvas) => recordingContext2d(canvas, drawn));
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return recordingContext2d(this, drawn);
        }
      },
    );
  });

  afterEach(() => {
    restoreCanvas();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("keeps the shared atlas near its cap however many colours the output brings", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal({ cols: 80, rows: 24 });
    term.open(host);
    const addon = new CanvasAddon();
    term.loadAddon(addon);
    capGlyphAtlas(addon);
    const pages = new Set<HTMLCanvasElement>();
    addon.onAddTextureAtlasCanvas((page) => pages.add(page));

    // Frame after frame of cells, each in a colour never seen before — three
    // times what the cap holds, in frames of a few lines, as output arrives.
    let clears = 0;
    const clear = addon.clearTextureAtlas.bind(addon);
    addon.clearTextureAtlas = () => {
      clears++;
      clear();
    };
    for (let k = 0; k < 24_000; k += 200) {
      let frame = "\x1b[H";
      for (let cell = k; cell < k + 200; cell++) {
        frame += `\x1b[38;2;${cell & 255};${(cell >> 8) & 255};7mx`;
      }
      term.write(frame);
      await vi.advanceTimersByTimeAsync(20);
    }

    // It overflowed, more than once: a cleared atlas keeps its pages, so only
    // the page a frame adds past the cap is new each time round.
    expect(clears, "the output never overflowed the cap").toBeGreaterThan(1);
    expect(pages.size).toBeLessThanOrEqual(GLYPH_ATLAS_PAGES_KEPT + clears);
    term.dispose();
  });
});
