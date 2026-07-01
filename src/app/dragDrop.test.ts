// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { collectPaneRects, deliverDrop } from "./dragDrop";
import { registerPaneInput } from "./paneInput";

describe("collectPaneRects (real DOM)", () => {
  it("extracts pane ids from the active grid, skipping hidden grids", () => {
    document.body.innerHTML = `
      <main class="deck__grid">
        <section data-pane-id="pane-7"></section>
        <section data-pane-id="pane-8"></section>
      </main>
      <main class="deck__grid deck__grid--hidden">
        <section data-pane-id="pane-99"></section>
      </main>`;
    expect(collectPaneRects().map((r) => r.id)).toEqual(["pane-7", "pane-8"]);
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
