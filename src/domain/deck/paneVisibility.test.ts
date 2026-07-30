import { describe, expect, it } from "vitest";
import { partitionPanes, type Pane } from "./panes";
import { paneOnScreen, resolveSelectedPaneId } from "./paneVisibility";

const seed = (count: number): Pane[] =>
  Array.from({ length: count }, (_, index) => ({ id: `pane-${index + 1}` }));

describe("partitionPanes", () => {
  it("keeps the live array reference when nothing is minimized", () => {
    const panes = seed(3);
    const result = partitionPanes(panes, undefined);
    expect(result.live).toBe(panes);
    expect(result.minimized).toEqual([]);
    expect(partitionPanes(panes, []).live).toBe(panes);
  });

  it("splits by the minimized set while preserving pane order", () => {
    const panes = seed(4);
    const { live, minimized } = partitionPanes(panes, ["pane-3", "pane-1"]);
    expect(live.map((pane) => pane.id)).toEqual(["pane-2", "pane-4"]);
    expect(minimized.map((pane) => pane.id)).toEqual(["pane-1", "pane-3"]);
  });

  it("ignores minimized ids that no longer match a pane", () => {
    const panes = seed(2);
    const { live, minimized } = partitionPanes(panes, ["pane-2", "pane-99"]);
    expect(live.map((pane) => pane.id)).toEqual(["pane-1"]);
    expect(minimized.map((pane) => pane.id)).toEqual(["pane-2"]);
  });
});

describe("paneOnScreen", () => {
  const panes = seed(3);
  const withSuspended: Pane[] = [
    {
      ...panes[0],
      idle: {
        reason: "suspended",
        at: "2026-07-29T10:00:00.000Z",
      },
    },
    ...panes.slice(1),
  ];

  it("shows every tiled grid pane", () => {
    expect(paneOnScreen(panes, undefined, "grid", true, "pane-2")).toBe(true);
  });

  it("hides manual minimizes only while grid minimization is enabled", () => {
    const view = { minimized: ["pane-2"] };
    expect(paneOnScreen(panes, view, "grid", true, "pane-2")).toBe(false);
    expect(paneOnScreen(panes, view, "grid", true, "pane-1")).toBe(true);
    expect(paneOnScreen(panes, view, "grid", false, "pane-2")).toBe(true);
  });

  it("shows only the maximized grid pane", () => {
    const view = { focus: "pane-1" };
    expect(paneOnScreen(panes, view, "grid", true, "pane-1")).toBe(true);
    expect(paneOnScreen(panes, view, "grid", true, "pane-2")).toBe(false);
  });

  it("treats a stale maximize as no maximize", () => {
    expect(
      paneOnScreen(panes, { focus: "pane-gone" }, "grid", true, "pane-2"),
    ).toBe(true);
  });

  it("treats maximize on a solo pane as a no-op", () => {
    expect(
      paneOnScreen(seed(1), { focus: "pane-1" }, "grid", true, "pane-1"),
    ).toBe(true);
  });

  it("shows only the expanded List pane and defaults to the first", () => {
    expect(paneOnScreen(panes, { select: "pane-2" }, "list", false, "pane-2")).toBe(
      true,
    );
    expect(paneOnScreen(panes, { select: "pane-2" }, "list", false, "pane-1")).toBe(
      false,
    );
    expect(paneOnScreen(panes, undefined, "list", false, "pane-1")).toBe(true);
    expect(paneOnScreen(panes, undefined, "list", false, "pane-2")).toBe(false);
  });

  it("applies suspended tray placement in either layout", () => {
    const view = { select: "pane-1", suspendedTray: ["pane-1"] };
    expect(paneOnScreen(withSuspended, view, "grid", true, "pane-1")).toBe(false);
    expect(paneOnScreen(withSuspended, view, "grid", true, "pane-2")).toBe(true);
    expect(paneOnScreen(withSuspended, view, "list", false, "pane-1")).toBe(false);
    expect(paneOnScreen(withSuspended, view, "list", false, "pane-2")).toBe(true);
    expect(withSuspended[0].idle?.reason).toBe("suspended");
  });

  it("shows a suspended pane restored from the tray without waking it", () => {
    expect(
      paneOnScreen(
        withSuspended,
        { select: "pane-1" },
        "grid",
        true,
        "pane-1",
      ),
    ).toBe(true);
    expect(withSuspended[0].idle?.reason).toBe("suspended");
  });

  it("keeps a suspended pane without tray placement visible", () => {
    expect(paneOnScreen(withSuspended, undefined, "grid", true, "pane-1")).toBe(
      true,
    );
  });

  it("never shows an unknown pane", () => {
    expect(paneOnScreen(panes, undefined, "grid", true, "pane-99")).toBe(false);
    expect(paneOnScreen([], undefined, "list", false, "pane-1")).toBe(false);
  });

  it("resolves List selection from tray placement, not dormant minimizes", () => {
    expect(
      resolveSelectedPaneId(
        panes,
        {
          select: "pane-2",
          minimized: ["pane-1"],
          suspendedTray: ["pane-2"],
        },
        "list",
        false,
      ),
    ).toBe("pane-1");
  });
});
