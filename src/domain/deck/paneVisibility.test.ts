import { describe, expect, it } from "vitest";
import type { Pane } from "./panes";
import {
  hiddenBy,
  paneOnScreen,
  resolveSelectedPaneId,
  visiblePanes,
  type PaneVisibilityView,
} from "./paneVisibility";

const seed = (count: number): Pane[] =>
  Array.from({ length: count }, (_, index) => ({ id: `pane-${index + 1}` }));

describe("hiddenBy", () => {
  it("names each reason a pane is off the grid, in a fixed order, and none for a pane on it", () => {
    expect(hiddenBy(undefined, "pane-1")).toEqual([]);
    expect(hiddenBy({}, "pane-1")).toEqual([]);
    expect(hiddenBy({ minimized: ["pane-1"] }, "pane-1")).toEqual(["minimized"]);
    expect(hiddenBy({ suspendedTray: ["pane-1"] }, "pane-1")).toEqual(["suspendedTray"]);
    // Both at once — a suspend from the grid leaves a pane in both lists.
    expect(hiddenBy({ minimized: ["pane-1"], suspendedTray: ["pane-1"] }, "pane-1")).toEqual([
      "minimized",
      "suspendedTray",
    ]);
    expect(hiddenBy({ minimized: ["pane-2"] }, "pane-1")).toEqual([]);
  });

  it("does not count the maximize spotlight — a covered pane is still on the grid", () => {
    const view: PaneVisibilityView = { focus: "pane-1" };
    expect(hiddenBy(view, "pane-2")).toEqual([]);
  });
});

describe("visiblePanes", () => {
  it("drops a pane for either reason, and both", () => {
    const panes = seed(3);
    const view = { minimized: ["pane-1"], suspendedTray: ["pane-3"] };
    expect(visiblePanes(panes, view).map((pane) => pane.id)).toEqual(["pane-2"]);
  });

  it("hands the same array back when nothing is hidden, and keeps pane order otherwise", () => {
    const panes = seed(4);
    expect(visiblePanes(panes, undefined)).toBe(panes);
    expect(visiblePanes(panes, { minimized: [] })).toBe(panes);
    expect(visiblePanes(panes, { focus: "pane-1" })).toBe(panes);
    // Ids that match nothing hide nothing, so the same array comes back;
    // and an empty deck is its own empty answer.
    expect(visiblePanes(panes, { minimized: ["pane-99"] })).toBe(panes);
    const none: Pane[] = [];
    expect(visiblePanes(none, { minimized: ["pane-1"] })).toBe(none);
    // A hidden id that no longer matches a pane is simply ignored: the lists
    // self-heal over any pane removal without every removal path pruning them.
    expect(
      visiblePanes(panes, { minimized: ["pane-3", "pane-99"], suspendedTray: ["pane-1"] }).map(
        (pane) => pane.id,
      ),
    ).toEqual(["pane-2", "pane-4"]);
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

  it("shows every tiled pane", () => {
    expect(paneOnScreen(panes, undefined, "pane-2")).toBe(true);
  });

  it("hides a minimized pane and keeps its siblings", () => {
    const view = { minimized: ["pane-2"] };
    expect(paneOnScreen(panes, view, "pane-2")).toBe(false);
    expect(paneOnScreen(panes, view, "pane-1")).toBe(true);
  });

  it("shows only the maximized pane", () => {
    const view = { focus: "pane-1" };
    expect(paneOnScreen(panes, view, "pane-1")).toBe(true);
    expect(paneOnScreen(panes, view, "pane-2")).toBe(false);
  });

  it("treats a stale maximize as no maximize", () => {
    expect(paneOnScreen(panes, { focus: "pane-gone" }, "pane-2")).toBe(true);
  });

  it("treats maximize on a solo pane as a no-op", () => {
    expect(paneOnScreen(seed(1), { focus: "pane-1" }, "pane-1")).toBe(true);
  });

  it("applies suspended tray placement", () => {
    const view = { select: "pane-1", suspendedTray: ["pane-1"] };
    expect(paneOnScreen(withSuspended, view, "pane-1")).toBe(false);
    expect(paneOnScreen(withSuspended, view, "pane-2")).toBe(true);
    expect(withSuspended[0].idle?.reason).toBe("suspended");
  });

  it("shows a suspended pane restored from the tray without waking it", () => {
    expect(paneOnScreen(withSuspended, { select: "pane-1" }, "pane-1")).toBe(true);
    expect(withSuspended[0].idle?.reason).toBe("suspended");
  });

  it("keeps a suspended pane without tray placement visible", () => {
    expect(paneOnScreen(withSuspended, undefined, "pane-1")).toBe(true);
  });

  it("never shows an unknown pane", () => {
    expect(paneOnScreen(panes, undefined, "pane-99")).toBe(false);
    expect(paneOnScreen([], undefined, "pane-1")).toBe(false);
  });
});

describe("resolveSelectedPaneId", () => {
  const panes = seed(3);

  it("keeps a live selection", () => {
    expect(resolveSelectedPaneId(panes, { select: "pane-2" })).toBe("pane-2");
  });

  it("falls back to the first live pane when the tray hid the selection", () => {
    // The suspend-to-tray transition is the one that may strand a selection
    // on a hidden pane; the grid then presents the first pane still on it.
    expect(
      resolveSelectedPaneId(panes, {
        select: "pane-2",
        minimized: ["pane-1"],
        suspendedTray: ["pane-2"],
      }),
    ).toBe("pane-3");
  });

  it("falls back to a lone live pane, and to nothing among several", () => {
    expect(
      resolveSelectedPaneId(panes, { select: "pane-9", minimized: ["pane-1", "pane-2"] }),
    ).toBe("pane-3");
    expect(resolveSelectedPaneId(panes, { select: "pane-9" })).toBeUndefined();
    // A selection minimized by hand is not repaired here: the reducer moved
    // it off the pane when it went, so a stale one is stale.
    expect(
      resolveSelectedPaneId(panes, { select: "pane-1", minimized: ["pane-1"] }),
    ).toBeUndefined();
  });
});
