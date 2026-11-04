// @vitest-environment happy-dom
/**
 * Pins the KeepDeck patch on @xterm/addon-canvas (patches/), both halves:
 * glyphs are drawn from the atlas page canvases, never from ImageBitmap copies
 * of them; and a cleared atlas page forgets the glyphs it held.
 *
 * Upstream skips the bitmaps only when it sniffs Safari, and WKWebView's
 * user agent carries no "Safari" token — so without the patch the canvas
 * renderer draws every glyph from GPU-side bitmaps, which WebKit discards
 * whenever it kills its GPU process: every pane goes blank at once. This
 * suite runs the real terminal + addon over a recording 2D context, under a
 * non-Safari user agent (happy-dom's, like Tauri's), and fails if the patch
 * is ever lost — an addon upgrade, a dropped patchedDependencies entry.
 *
 * The second half is what makes clearing the atlas (glyphAtlas.ts) give
 * memory back: upstream's page clear wipes the pixels but keeps the page's
 * list of every glyph ever placed on it, so each clear would leave a page's
 * worth of glyph records behind for good. That list is internal and nothing
 * public reads it, so the pin reads it where it lives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
import { recordingContext2d, stubCanvasContext } from "../canvasContext.test-support";

let drawn: unknown[];
let createImageBitmap: ReturnType<typeof vi.fn>;
let restoreCanvas: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  drawn = [];
  restoreCanvas = stubCanvasContext((canvas) => recordingContext2d(canvas, drawn));
  // xterm measures its cell off an OffscreenCanvas; happy-dom's has no 2D
  // context, and a zero cell renders nothing.
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      getContext() {
        return recordingContext2d(this, drawn);
      }
    },
  );
  createImageBitmap = vi.fn(async () => ({ close: () => {} }));
  vi.stubGlobal("createImageBitmap", createImageBitmap);
});

afterEach(() => {
  restoreCanvas();
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

  it("forgets a page's glyphs when the atlas is cleared", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal({ cols: 40, rows: 5 });
    term.open(host);
    const addon = new CanvasAddon();
    term.loadAddon(addon);
    term.write("\x1b[32mglyphs in green\x1b[0m\r\n");
    await vi.advanceTimersByTimeAsync(250);
    const placed = () => glyphsOnFirstPage(term);
    expect(placed()).toBeGreaterThan(0);

    addon.clearTextureAtlas();
    expect(placed()).toBe(0);
    term.dispose();
  });
});

/** How many glyph records the shared atlas's first page holds — reached
 * through xterm's internals, the only place the list lives. */
function glyphsOnFirstPage(term: Terminal): number {
  let at: unknown = term;
  for (const key of ["_core", "_renderService", "_renderer", "value", "_renderLayers", "0", "_charAtlas", "pages", "0", "glyphs"]) {
    at = typeof at === "object" && at !== null ? Reflect.get(at, key) : undefined;
  }
  if (!Array.isArray(at)) throw new Error("the atlas's first page has no glyph list where the pin looks");
  return at.length;
}
