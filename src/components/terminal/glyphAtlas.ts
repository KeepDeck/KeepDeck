import type { CanvasAddon } from "@xterm/addon-canvas";

/** How many 512×512 pages (1 MB each) the glyph atlas may hold before it is
 * cleared. Comfortably above what the agents' palettes fill in a working
 * day, so a clear is the exception, not a rhythm. A cleared atlas keeps its
 * pages, so the next clear waits until every one of them has filled again —
 * thousands of new glyphs, never one per frame. */
export const GLYPH_ATLAS_PAGES_KEPT = 16;

/**
 * Keep the canvas renderer's glyph atlas from growing for good.
 *
 * Every pane with the same font and theme shares one atlas, and it rasterizes
 * each new character-and-colour pair onto a page it never gives back: the
 * canvas renderer sets no page limit (only the WebGL one does), so output in
 * new colours adds pages for as long as the app runs. Past the cap the atlas
 * is cleared: its pages stay and are filled again, the screen keeps what is
 * already drawn, and a glyph is rasterized again the next time it appears.
 *
 * Pages are counted through the addon's own events. A page is added in the
 * middle of drawing a frame, so the clear waits for the frame to end. A new
 * atlas — a theme or pixel-ratio change replaces it, and `textureAtlas` names
 * its first page — starts its own count.
 */
export function capGlyphAtlas(
  addon: Pick<CanvasAddon, "onAddTextureAtlasCanvas" | "clearTextureAtlas" | "textureAtlas">,
): void {
  let atlas: HTMLCanvasElement | undefined;
  const pages = new Set<HTMLCanvasElement>();
  let clearing = false;
  addon.onAddTextureAtlasCanvas((page) => {
    if (addon.textureAtlas !== atlas) {
      atlas = addon.textureAtlas;
      pages.clear();
      if (atlas) pages.add(atlas);
    }
    pages.add(page);
    if (pages.size <= GLYPH_ATLAS_PAGES_KEPT || clearing) return;
    clearing = true;
    setTimeout(() => {
      clearing = false;
      addon.clearTextureAtlas();
    }, 0);
  });
}
