// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  collectPaneRects,
  deliverDrop,
  deliverPathToPoint,
} from "./dragDrop";
import { registerPaneInput } from "./paneInput";

describe("collectPaneRects (real DOM)", () => {
  // Fixtures mirror DeckStage's real structure: a .deck__workspace layer per
  // workspace, hidden ones carrying --hidden, panes inside the grid wrap.
  it("extracts pane ids from the active workspace, skipping hidden ones (grid)", () => {
    document.body.innerHTML = `
      <main class="deck__workspace">
        <div class="deck__gridwrap"><div class="deck__grid">
          <section data-pane-id="pane-7"></section>
          <section data-pane-id="pane-8"></section>
        </div></div>
      </main>
      <main class="deck__workspace deck__workspace--hidden">
        <div class="deck__gridwrap"><div class="deck__grid">
          <section data-pane-id="pane-99"></section>
        </div></div>
      </main>`;
    expect(collectPaneRects().map((r) => r.id)).toEqual(["pane-7", "pane-8"]);
  });

  it("finds panes in the list layout too — drops must not go dead there", () => {
    document.body.innerHTML = `
      <main class="deck__workspace">
        <div class="deck__gridwrap"><div class="deck__list-inner">
          <section data-pane-id="pane-1"></section>
          <section data-pane-id="pane-2"></section>
        </div></div>
      </main>`;
    expect(collectPaneRects().map((r) => r.id)).toEqual(["pane-1", "pane-2"]);
  });
});

describe("deliverDrop", () => {
  it("writes the formatted paths (image bracketed) into the target pane", () => {
    const write = vi.fn();
    const off = registerPaneInput("pane-9", write);
    expect(deliverDrop("pane-9", ["/x/shot.png"], [true])).toBe(true);
    expect(write).toHaveBeenCalledWith("\x1b[200~/x/shot.png\x1b[201~");
    off();
  });

  it("no-ops with no target pane or no paths", () => {
    expect(deliverDrop(null, ["/a"], [false])).toBe(false);
    const off = registerPaneInput("pane-10", () => {});
    expect(deliverDrop("pane-10", [], [])).toBe(false);
    off();
  });
});

describe("deliverPathToPoint (in-app pointer path drag)", () => {
  const rects = [{ id: "pane-1", rect: { left: 0, top: 0, right: 100, bottom: 100 } }];

  it("writes a dragged path into the pane under the drop point, returning its id", async () => {
    const write = vi.fn();
    const off = registerPaneInput("pane-1", write);
    const id = await deliverPathToPoint(
      "/repo/main.ts",
      { x: 50, y: 50 },
      rects,
      async () => [false],
    );
    expect(id).toBe("pane-1");
    expect(write).toHaveBeenCalledWith("/repo/main.ts");
    off();
  });

  it("bracket-pastes an image path so the agent attaches it", async () => {
    const write = vi.fn();
    const off = registerPaneInput("pane-1", write);
    await deliverPathToPoint("/repo/logo.png", { x: 10, y: 10 }, rects, async () => [true]);
    expect(write).toHaveBeenCalledWith("\x1b[200~/repo/logo.png\x1b[201~");
    off();
  });

  it("ignores an empty path", async () => {
    const result = await deliverPathToPoint("", { x: 50, y: 50 }, rects, async () => []);
    expect(result).toBeNull();
  });

  it("ignores a drop that misses every pane", async () => {
    const off = registerPaneInput("pane-1", vi.fn());
    const result = await deliverPathToPoint("/a", { x: 500, y: 500 }, rects, async () => [false]);
    expect(result).toBeNull();
    off();
  });

  it("treats an image-sniff failure as plain text, not a dropped file", async () => {
    const write = vi.fn();
    const off = registerPaneInput("pane-1", write);
    await deliverPathToPoint("/a/f", { x: 1, y: 1 }, rects, async () => {
      throw new Error("sniff failed");
    });
    expect(write).toHaveBeenCalledWith("/a/f");
    off();
  });
});
