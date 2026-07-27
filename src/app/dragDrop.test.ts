// @vitest-environment happy-dom
import { DROP_BLOCKER_ATTR } from "@keepdeck/ui-kit/dropBlocker";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../ipc/log";
import { deliverPathsToPoint } from "./dragDrop";
import { registerPaneInput } from "./paneInput";

/** happy-dom lays nothing out, so a fixture states its own geometry. */
function place(
  el: Element,
  box: { left: number; top: number; right: number; bottom: number },
): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(box as DOMRect);
}

/**
 * The deck as DeckStage really builds it: a `.deck__workspace` layer per
 * workspace, hidden ones carrying `--hidden`, panes inside the grid wrap.
 * `pane-1` occupies the left half, `pane-2` the right.
 */
function deck({ layout = "grid" as "grid" | "list", hidden = false } = {}): void {
  const inner = layout === "grid" ? "deck__grid" : "deck__list-inner";
  document.body.innerHTML = `
    <main class="deck__workspace">
      <div class="deck__gridwrap"><div class="${inner}">
        <section data-pane-id="pane-1"></section>
        <section data-pane-id="pane-2"></section>
      </div></div>
    </main>
    ${
      hidden
        ? `<main class="deck__workspace deck__workspace--hidden">
             <div class="deck__gridwrap"><div class="deck__grid">
               <section data-pane-id="pane-99"></section>
             </div></div>
           </main>`
        : ""
    }`;
  place(document.querySelector('[data-pane-id="pane-1"]')!, {
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
  });
  place(document.querySelector('[data-pane-id="pane-2"]')!, {
    left: 100,
    top: 0,
    right: 200,
    bottom: 100,
  });
  // An inactive layer keeps REAL rects at the same coordinates — that is what
  // makes the `--hidden` exclusion load-bearing rather than cosmetic.
  if (hidden) {
    place(document.querySelector('[data-pane-id="pane-99"]')!, {
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
    });
  }
}

/** Put a declared blocker over `pane-2`, the way a floating dock or an open
 * peek covers part of the deck. */
function cover(box = { left: 100, top: 0, right: 200, bottom: 100 }): void {
  const el = document.body.appendChild(document.createElement("aside"));
  el.setAttribute(DROP_BLOCKER_ATTR, "");
  place(el, box);
}

const noImages = async (paths: string[]) => paths.map(() => false);

describe("deliverPathsToPoint — the whole drop, for both entry points", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("writes a dragged path into the pane under the drop point, returning its id", async () => {
    deck();
    const write = vi.fn();
    const off = registerPaneInput("pane-1", { write });
    const id = await deliverPathsToPoint(["/repo/main.ts"], { x: 50, y: 50 }, noImages);
    expect(id).toBe("pane-1");
    expect(write).toHaveBeenCalledWith("/repo/main.ts");
    off();
  });

  it("writes a whole OS drop's paths in one insertion", async () => {
    // The Finder path carries many at once; the pointer drag carries one.
    deck();
    const write = vi.fn();
    const off = registerPaneInput("pane-1", { write });
    const id = await deliverPathsToPoint(
      ["/repo/a.ts", "/repo/b.ts"],
      { x: 50, y: 50 },
      noImages,
    );
    expect(id).toBe("pane-1");
    expect(write).toHaveBeenCalledWith("/repo/a.ts /repo/b.ts");
    off();
  });

  it("drops the blanks out of a batch and delivers the rest", async () => {
    // One unresolvable path in a multi-file drop must cost that path, not the
    // drop: the sniff and the insertion both have to see the same filtered
    // list, or the image flags land on the wrong names.
    deck();
    const write = vi.fn();
    const off = registerPaneInput("pane-1", { write });
    const id = await deliverPathsToPoint(
      ["", "/repo/a.ts", "", "/repo/logo.png"],
      { x: 50, y: 50 },
      async (paths) => paths.map((p) => p.endsWith(".png")),
    );
    expect(id).toBe("pane-1");
    expect(write).toHaveBeenCalledWith(
      "/repo/a.ts \x1b[200~/repo/logo.png\x1b[201~",
    );
    off();
  });

  it("bracket-pastes an image path so the agent attaches it", async () => {
    deck();
    const write = vi.fn();
    const off = registerPaneInput("pane-1", { write });
    await deliverPathsToPoint(["/repo/logo.png"], { x: 10, y: 10 }, async () => [true]);
    expect(write).toHaveBeenCalledWith("\x1b[200~/repo/logo.png\x1b[201~");
    off();
  });

  it("ignores a drop with nothing to deliver", async () => {
    deck();
    expect(await deliverPathsToPoint([], { x: 50, y: 50 }, noImages)).toBeNull();
    expect(await deliverPathsToPoint([""], { x: 50, y: 50 }, noImages)).toBeNull();
  });

  it("ignores a drop that misses every pane", async () => {
    deck();
    const off = registerPaneInput("pane-1", { write: vi.fn() });
    expect(
      await deliverPathsToPoint(["/a"], { x: 500, y: 500 }, noImages),
    ).toBeNull();
    off();
  });

  it("refuses a drop released on a surface covering the deck", async () => {
    // The point is inside pane-2's rect, and pane-2 is still laid out under
    // the panel — which is exactly why the pane list alone is not an answer.
    deck();
    cover();
    const write = vi.fn();
    const off = registerPaneInput("pane-2", { write });
    expect(
      await deliverPathsToPoint(["/a"], { x: 150, y: 50 }, noImages),
    ).toBeNull();
    expect(write).not.toHaveBeenCalled();
    off();
  });

  it("leaves the deck reachable everywhere the surface does not cover", async () => {
    deck();
    cover();
    const off = registerPaneInput("pane-1", { write: vi.fn() });
    expect(await deliverPathsToPoint(["/a"], { x: 50, y: 50 }, noImages)).toBe(
      "pane-1",
    );
    off();
  });

  it("never delivers into a workspace nobody is looking at", async () => {
    // The hidden layer's pane sits at the same coordinates and keeps a real
    // rect, so the only thing keeping the drop out of it is the selector.
    deck({ hidden: true });
    const active = vi.fn();
    const offscreen = vi.fn();
    const offActive = registerPaneInput("pane-1", { write: active });
    const offHidden = registerPaneInput("pane-99", { write: offscreen });
    expect(await deliverPathsToPoint(["/a"], { x: 50, y: 50 }, noImages)).toBe(
      "pane-1",
    );
    expect(offscreen).not.toHaveBeenCalled();
    expect(active).toHaveBeenCalled();
    offActive();
    offHidden();
  });

  it("finds panes in the list layout too — drops must not go dead there", async () => {
    deck({ layout: "list" });
    const off = registerPaneInput("pane-2", { write: vi.fn() });
    expect(await deliverPathsToPoint(["/a"], { x: 150, y: 50 }, noImages)).toBe(
      "pane-2",
    );
    off();
  });

  it("treats an image-sniff failure as plain text, not a dropped file", async () => {
    deck();
    const write = vi.fn();
    const off = registerPaneInput("pane-1", { write });
    vi.spyOn(log, "debug").mockImplementation(() => {});
    await deliverPathsToPoint(["/a/f"], { x: 1, y: 1 }, async () => {
      throw new Error("sniff failed");
    });
    expect(write).toHaveBeenCalledWith("/a/f");
    off();
  });

  it("traces a sniff failure rather than degrading the drop in silence", async () => {
    // The two entry points used to disagree here: one logged, one swallowed,
    // so the same backend failure was diagnosable through a Finder drop and
    // invisible through a dragged tree row.
    deck();
    const off = registerPaneInput("pane-1", { write: vi.fn() });
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    await deliverPathsToPoint(["/a/f"], { x: 1, y: 1 }, async () => {
      throw new Error("sniff failed");
    });
    expect(debug).toHaveBeenCalledWith(
      "web:dnd",
      expect.stringContaining("sniff failed"),
    );
    off();
  });
});
