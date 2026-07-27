// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { DockPanel } from "../components/dock/DockPanel";
import { collectDropSurface, deliverDrop, deliverPathToPoint } from "./dragDrop";
import { registerPaneInput } from "./paneInput";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
  // these feed is paneDnd's to test. What IS testable here is the contract
  // between a surface that declares itself a blocker and the query that finds
  // it. So the dock below is the REAL component: a hand-written fixture would
  // carry whatever marker this module happens to look for, and prove only that
  // a string equals itself — which is exactly how a half-finished rename would
  // ship a dock that still looks floating and no longer blocks anything.
  const DECK = `
      <main class="deck__workspace">
        <div class="deck__gridwrap"><div class="deck__grid">
          <section data-pane-id="pane-1"></section>
        </div></div>
      </main>`;

  const mountDock = (floating: boolean): Root => {
    document.body.innerHTML = `${DECK}<div id="dock-host"></div>`;
    const root = createRoot(document.getElementById("dock-host")!);
    act(() =>
      root.render(
        createElement(DockPanel, {
          tabs: [{ id: "p:one", label: "One", element: "body" }],
          activeTab: null,
          onSelectTab: () => {},
          floating,
        }),
      ),
    );
    return root;
  };

  it("reports no blocker while the dock is docked — it covers nothing", () => {
    const root = mountDock(false);
    const surface = collectDropSurface();
    expect(surface.panes.map((p) => p.id)).toEqual(["pane-1"]);
    expect(surface.blockers).toEqual([]);
    act(() => root.unmount());
  });

  it("finds the floating dock the dock itself marked, alongside the panes", () => {
    const root = mountDock(true);
    const surface = collectDropSurface();
    expect(surface.panes.map((p) => p.id)).toEqual(["pane-1"]);
    expect(surface.blockers).toHaveLength(1);
    act(() => root.unmount());
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

describe("deliverPathToPoint (in-app pointer path drag)", () => {
  const surface = {
    panes: [{ id: "pane-1", rect: { left: 0, top: 0, right: 100, bottom: 100 } }],
    blockers: [],
  };

  it("writes a dragged path into the pane under the drop point, returning its id", async () => {
    const write = vi.fn();
    const off = registerPaneInput("pane-1", { write });
    const id = await deliverPathToPoint(
      "/repo/main.ts",
      { x: 50, y: 50 },
      surface,
      async () => [false],
    );
    expect(id).toBe("pane-1");
    expect(write).toHaveBeenCalledWith("/repo/main.ts");
    off();
  });

  it("bracket-pastes an image path so the agent attaches it", async () => {
    const write = vi.fn();
    const off = registerPaneInput("pane-1", { write });
    await deliverPathToPoint("/repo/logo.png", { x: 10, y: 10 }, surface, async () => [true]);
    expect(write).toHaveBeenCalledWith("\x1b[200~/repo/logo.png\x1b[201~");
    off();
  });

  it("ignores an empty path", async () => {
    const result = await deliverPathToPoint("", { x: 50, y: 50 }, surface, async () => []);
    expect(result).toBeNull();
  });

  it("ignores a drop that misses every pane", async () => {
    const off = registerPaneInput("pane-1", { write: vi.fn() });
    const result = await deliverPathToPoint("/a", { x: 500, y: 500 }, surface, async () => [false]);
    expect(result).toBeNull();
    off();
  });

  it("treats an image-sniff failure as plain text, not a dropped file", async () => {
    const write = vi.fn();
    const off = registerPaneInput("pane-1", { write });
    await deliverPathToPoint("/a/f", { x: 1, y: 1 }, surface, async () => {
      throw new Error("sniff failed");
    });
    expect(write).toHaveBeenCalledWith("/a/f");
    off();
  });
});
