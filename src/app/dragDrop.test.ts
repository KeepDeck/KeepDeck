// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  collectPaneRects,
  deliverDrop,
  deliverPathDrop,
  PANE_PATH_DROP_TYPE,
} from "./dragDrop";
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

describe("deliverPathDrop (in-app HTML5 path drag)", () => {
  const rects = [{ id: "pane-1", rect: { left: 0, top: 0, right: 100, bottom: 100 } }];
  const transfer = (
    path: string | null,
  ): Pick<DataTransfer, "types" | "getData"> => ({
    types: path === null ? [] : [PANE_PATH_DROP_TYPE],
    getData: (type: string) =>
      type === PANE_PATH_DROP_TYPE && path ? path : "",
  });

  it("writes a dragged path into the pane under the drop point, returning its id", async () => {
    const write = vi.fn();
    const off = registerPaneInput("pane-1", write);
    const id = await deliverPathDrop(
      transfer("/repo/main.ts"),
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
    await deliverPathDrop(transfer("/repo/logo.png"), { x: 10, y: 10 }, rects, async () => [true]);
    expect(write).toHaveBeenCalledWith("\x1b[200~/repo/logo.png\x1b[201~");
    off();
  });

  it("ignores a drag that lacks our dedicated type", async () => {
    const result = await deliverPathDrop(transfer(null), { x: 50, y: 50 }, rects, async () => []);
    expect(result).toBeNull();
  });

  it("ignores a drop that misses every pane", async () => {
    const off = registerPaneInput("pane-1", vi.fn());
    const result = await deliverPathDrop(transfer("/a"), { x: 500, y: 500 }, rects, async () => [false]);
    expect(result).toBeNull();
    off();
  });

  it("treats an image-sniff failure as plain text, not a dropped file", async () => {
    const write = vi.fn();
    const off = registerPaneInput("pane-1", write);
    await deliverPathDrop(transfer("/a/f"), { x: 1, y: 1 }, rects, async () => {
      throw new Error("sniff failed");
    });
    expect(write).toHaveBeenCalledWith("/a/f");
    off();
  });
});
