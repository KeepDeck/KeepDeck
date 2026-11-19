import { describe, expect, it } from "vitest";
import { backToCards, setViewField, unhidePaneView } from "./workspaceView";

describe("backToCards", () => {
  it("closes the team and drops the highlight, keeping the spotlight and the rest", () => {
    const next = backToCards(
      { a: { teamOpen: "t", select: "p1", focus: ["p1"], dock: true }, b: { teamOpen: "u" } },
      "a",
    );
    expect(next).toEqual({ a: { focus: ["p1"], dock: true }, b: { teamOpen: "u" } });
  });

  it("prunes a view left with nothing in it", () => {
    expect(backToCards({ a: { teamOpen: "t", select: "p1" } }, "a")).toEqual({});
  });
});

describe("setViewField", () => {
  it("keeps a view that still holds folded epics or a newer revision's fields when its last other field goes", () => {
    expect(setViewField({ a: { select: "p1", foldedEpics: ["u-1"] } }, "a", "select", undefined)).toEqual({ a: { foldedEpics: ["u-1"] } });
    expect(setViewField({ a: { select: "p1", extras: { future: 1 } } }, "a", "select", undefined)).toEqual({ a: { extras: { future: 1 } } });
    expect(setViewField({ a: { select: "p1" } }, "a", "select", undefined)).toEqual({});
  });
});

describe("unhidePaneView", () => {
  it("takes exactly the listed panes off one list, and never touches the other list or the highlight", () => {
    const viewByWs = {
      "ws-1": { teamOpen: "t", select: "p1", suspendedTray: ["p1", "p2", "p3"], minimized: ["p2"] },
    };
    expect(unhidePaneView(viewByWs, "ws-1", "suspendedTray", ["p1", "p2"])).toEqual({
      "ws-1": { teamOpen: "t", select: "p1", suspendedTray: ["p3"], minimized: ["p2"] },
    });
  });

  it("drops the list when the last pane leaves it", () => {
    const viewByWs = { "ws-1": { teamOpen: "t", suspendedTray: ["p1"] } };
    expect(unhidePaneView(viewByWs, "ws-1", "suspendedTray", ["p1"])).toEqual({ "ws-1": { teamOpen: "t" } });
  });

  it("returns the same map when none of the panes is in the tray", () => {
    const viewByWs = { "ws-1": { teamOpen: "t", suspendedTray: ["p3"] } };
    expect(unhidePaneView(viewByWs, "ws-1", "suspendedTray", ["p1"])).toBe(viewByWs);
    expect(unhidePaneView(viewByWs, "ws-2", "suspendedTray", ["p3"])).toBe(viewByWs);
    expect(unhidePaneView(viewByWs, "ws-1", "minimized", ["p3"])).toBe(viewByWs);
  });
});
