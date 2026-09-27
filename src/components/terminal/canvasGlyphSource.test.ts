// @vitest-environment happy-dom
/**
 * Pins the KeepDeck patch on @xterm/addon-canvas (patches/): glyphs are drawn
 * from the atlas page canvases, never from ImageBitmap copies of them.
 *
 * Upstream skips the bitmaps only when it sniffs Safari, and WKWebView's
 * user agent carries no "Safari" token — so without the patch the canvas
 * renderer draws every glyph from GPU-side bitmaps, which WebKit discards
 * whenever it kills its GPU process: every pane goes blank at once. This
 * suite runs the real terminal + addon over a recording 2D context, under a
 * non-Safari user agent (happy-dom's, like Tauri's), and fails if the patch
 * is ever lost — an addon upgrade, a dropped patchedDependencies entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";

/** A 2D context that accepts every call: enough surface for xterm to lay out
 * cells, rasterize glyphs and paint rows, recording the images it draws. */
function recordingContext(canvas: unknown, drawn: unknown[]) {
  const state: Record<string | symbol, unknown> = {};
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    measureText: () => ({
      width: 8,
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 3,
      fontBoundingBoxAscent: 12,
      fontBoundingBoxDescent: 4,
    }),
    getImageData: (_x, _y, w, h) => ({
      width: w,
      height: h,
      // Opaque ink everywhere, so glyph trimming finds something to keep.
      data: new Uint8ClampedArray(Math.max(1, Number(w) * Number(h)) * 4).fill(255),
    }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    drawImage: (image) => {
      drawn.push(image);
    },
  };
  return new Proxy(state, {
    get(target, key) {
      if (key === "canvas") return canvas;
      if (typeof key === "string" && key in methods) return methods[key];
      if (key in target) return target[key];
      return () => {};
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
}

let drawn: unknown[];
let createImageBitmap: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  drawn = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return recordingContext(this, drawn) as unknown as CanvasRenderingContext2D;
  } as never);
  // xterm measures its cell off an OffscreenCanvas; happy-dom's has no 2D
  // context, and a zero cell renders nothing.
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      getContext() {
        return recordingContext(this, drawn);
      }
    },
  );
  createImageBitmap = vi.fn(async () => ({ close: () => {} }));
  vi.stubGlobal("createImageBitmap", createImageBitmap);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("canvas renderer glyph source (patched @xterm/addon-canvas)", () => {
  it("draws glyphs from the atlas page canvases and never makes ImageBitmaps", async () => {
    // The condition KeepDeck ships under: xterm must not sniff Safari here.
    expect(navigator.userAgent).not.toMatch(/safari/i);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal({ cols: 40, rows: 5 });
    term.open(host);
    term.loadAddon(new CanvasAddon());

    // Rasterize fresh glyphs over several frames — each new glyph is what
    // would schedule a bitmap (100ms debounce upstream).
    for (const line of ["hello", "мир", "\x1b[1;31mbold red\x1b[0m"]) {
      term.write(`${line}\r\n`);
      await vi.advanceTimersByTimeAsync(250);
    }

    const glyphDraws = drawn.filter((image) => image instanceof HTMLCanvasElement);
    expect(glyphDraws.length).toBeGreaterThan(0);
    expect(createImageBitmap).not.toHaveBeenCalled();
    term.dispose();
  });
});
