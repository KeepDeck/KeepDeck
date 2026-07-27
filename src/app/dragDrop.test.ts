// @vitest-environment happy-dom
import { DROP_BLOCKER_ATTR } from "@keepdeck/ui-kit/dropBlocker";
import { describe, expect, it, vi } from "vitest";
import { log } from "../ipc/log";
import { collectDropSurface, deliverDrop, deliverPathsToPoint } from "./dragDrop";
import { registerPaneInput } from "./paneInput";

describe("collectDropSurface (real DOM)", () => {
  // Fixtures mirror DeckStage's real structure: a .deck__workspace layer per
  // workspace, hidden ones carrying --hidden, panes inside the grid wrap.
  it("takes panes from the active workspace, skipping hidden ones (grid)", () => {
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
    // An inactive layer keeps its real rects at the same coordinates, so a
    // drop could otherwise resolve to a pane in a workspace nobody is looking
    // at.
    expect(collectDropSurface().panes.map((p) => p.id)).toEqual([
      "pane-7",
      "pane-8",
    ]);
  });

  it("finds panes in the list layout too — drops must not go dead there", () => {
    document.body.innerHTML = `
      <main class="deck__workspace">
        <div class="deck__gridwrap"><div class="deck__list-inner">
          <section data-pane-id="pane-1"></section>
          <section data-pane-id="pane-2"></section>
        </div></div>
      </main>`;
    expect(collectDropSurface().panes.map((p) => p.id)).toEqual([
      "pane-1",
      "pane-2",
    ]);
  });

  // happy-dom lays nothing out, so every rect here is zero — the geometry
  // these feed is paneDnd's to test. What IS testable is that the query picks
  // up exactly the surfaces that declare themselves. The fixture builds its
  // marker from the SHARED constant, which is the whole reason the constant
  // exists: with one symbol there is no second literal for a rename to leave
  // behind. That each real surface actually carries it is asserted where that
  // surface lives — DockPanel, Peek and ModalOverlay each own that test.
  const DECK = `
      <main class="deck__workspace">
        <div class="deck__gridwrap"><div class="deck__grid">
          <section data-pane-id="pane-1"></section>
        </div></div>
      </main>`;

  it("reports no blocker when nothing covers the deck", () => {
    document.body.innerHTML = DECK;
    const surface = collectDropSurface();
    expect(surface.panes.map((p) => p.id)).toEqual(["pane-1"]);
    expect(surface.blockers).toEqual([]);
  });

  it("collects every declared blocker alongside the panes", () => {
    // Two at once is the real case: a peek opened from a floating dock.
    document.body.innerHTML = `${DECK}
      <aside ${DROP_BLOCKER_ATTR}></aside>
      <div ${DROP_BLOCKER_ATTR}></div>`;
    const surface = collectDropSurface();
    expect(surface.panes.map((p) => p.id)).toEqual(["pane-1"]);
    expect(surface.blockers).toHaveLength(2);
  });
});

describe("deliverDrop", () => {
  it("writes the formatted paths (image bracketed) into the target pane", () => {
    const write = vi.fn();
    const off = registerPaneInput("pane-9", { write });
    expect(deliverDrop("pane-9", ["/x/shot.png"], [true])).toBe(true);
    expect(write).toHaveBeenCalledWith("\x1b[200~/x/shot.png\x1b[201~");
    off();
  });

  it("no-ops with no target pane or no paths", () => {
    expect(deliverDrop(null, ["/a"], [false])).toBe(false);
    const off = registerPaneInput("pane-10", { write: () => {} });
    expect(deliverDrop("pane-10", [], [])).toBe(false);
    off();
  });
});

describe("deliverPathsToPoint (both drop paths)", () => {
  const surface = {
    panes: [{ id: "pane-1", rect: { left: 0, top: 0, right: 100, bottom: 100 } }],
    blockers: [],
  };

  it("writes a dragged path into the pane under the drop point, returning its id", async () => {
    const write = vi.fn();
    const off = registerPaneInput("pane-1", { write });
    const id = await deliverPathsToPoint(
      ["/repo/main.ts"],
      { x: 50, y: 50 },
      surface,
      async () => [false],
    );
    expect(id).toBe("pane-1");
    expect(write).toHaveBeenCalledWith("/repo/main.ts");
    off();
  });

  it("writes a whole OS drop's paths in one insertion", async () => {
    // The Finder path carries many at once; the pointer drag carries one. Both
    // now go through here, so the multi-path case is this function's too.
    const write = vi.fn();
    const off = registerPaneInput("pane-1", { write });
    const id = await deliverPathsToPoint(
      ["/repo/a.ts", "/repo/b.ts"],
      { x: 50, y: 50 },
      surface,
      async () => [false, false],
    );
    expect(id).toBe("pane-1");
    expect(write).toHaveBeenCalledWith("/repo/a.ts /repo/b.ts");
    off();
  });

  it("bracket-pastes an image path so the agent attaches it", async () => {
    const write = vi.fn();
    const off = registerPaneInput("pane-1", { write });
    await deliverPathsToPoint(["/repo/logo.png"], { x: 10, y: 10 }, surface, async () => [true]);
    expect(write).toHaveBeenCalledWith("\x1b[200~/repo/logo.png\x1b[201~");
    off();
  });

  it("ignores an empty path", async () => {
    const result = await deliverPathsToPoint([""], { x: 50, y: 50 }, surface, async () => []);
    expect(result).toBeNull();
  });

  it("ignores a drop that misses every pane", async () => {
    const off = registerPaneInput("pane-1", { write: vi.fn() });
    const result = await deliverPathsToPoint(["/a"], { x: 500, y: 500 }, surface, async () => [false]);
    expect(result).toBeNull();
    off();
  });

  it("treats an image-sniff failure as plain text, not a dropped file", async () => {
    const write = vi.fn();
    const off = registerPaneInput("pane-1", { write });
    await deliverPathsToPoint(["/a/f"], { x: 1, y: 1 }, surface, async () => {
      throw new Error("sniff failed");
    });
    expect(write).toHaveBeenCalledWith("/a/f");
    off();
  });

  it("traces a sniff failure rather than degrading the drop in silence", async () => {
    // The two drop paths used to disagree here: one logged, one swallowed, so
    // the same backend failure was diagnosable through Finder drops and
    // invisible through a dragged tree row.
    const off = registerPaneInput("pane-1", { write: vi.fn() });
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    await deliverPathsToPoint(["/a/f"], { x: 1, y: 1 }, surface, async () => {
      throw new Error("sniff failed");
    });
    expect(debug).toHaveBeenCalledWith("web:dnd", expect.stringContaining("sniff failed"));
    debug.mockRestore();
    off();
  });
});
