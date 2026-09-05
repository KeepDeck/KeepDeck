import { describe, expect, it } from "vitest";
import { visiblePanes, type Pane, type PaneVisibilityView } from "../domain/deck";
import { emptyGridMessage, trayView } from "./trayView";

const pane = (id: string, suspended = false): Pane => ({
  id,
  ...(suspended ? { idle: { reason: "suspended" as const, at: "2026-09-06T10:00:00.000Z" } } : {}),
});

const panes = [pane("a"), pane("b"), pane("c")];
const ids = (view: PaneVisibilityView | undefined, focusedHere: string | null = null) =>
  trayView(panes, view, focusedHere).entries;

describe("trayView", () => {
  it("shelves a pane for each reason it is off the grid, and none when it is on it", () => {
    expect(ids(undefined)).toEqual([]);
    expect(ids({ minimized: ["b"] })).toEqual([{ paneId: "b", reason: "minimized" }]);
    expect(ids({ suspendedTray: ["c"] })).toEqual([{ paneId: "c", reason: "suspendedTray" }]);
  });

  it("shelves the panes a maximize covers, with a spotlight restore — never the focused one", () => {
    expect(ids(undefined, "a")).toEqual([
      { paneId: "b", reason: "maximized" },
      { paneId: "c", reason: "maximized" },
    ]);
    // A lone pane cannot be covered by its own spotlight.
    expect(trayView([pane("a")], undefined, "a").entries).toEqual([]);
  });

  it("shelves a pane carrying both marks for the tray restore, not the unminimize", () => {
    // Minimized by hand, then suspended from the grid: the tray restore is
    // the transition that knows how to bring it back; an unminimize would
    // leave it stopped behind the grid.
    expect(ids({ minimized: ["b"], suspendedTray: ["b"] })).toEqual([
      { paneId: "b", reason: "suspendedTray" },
    ]);
  });

  it("keeps pane order, whatever order the lists and the spotlight came in", () => {
    expect(ids({ minimized: ["c"], suspendedTray: ["a"] }, "b").map((e) => e.paneId)).toEqual([
      "a",
      "c",
    ]);
    expect(ids({ suspendedTray: ["c", "a"] }).map((e) => e.paneId)).toEqual(["a", "c"]);
  });

  it("names the shelf by what it holds — Minimized, Suspended, or Hidden when they mix", () => {
    const stopped = [pane("a", true), pane("b", true), pane("c")];
    expect(trayView(panes, { minimized: ["a"] }, null).stateLabel).toBe("Minimized");
    expect(trayView(panes, undefined, "a").stateLabel).toBe("Minimized");
    expect(trayView(stopped, { suspendedTray: ["a", "b"] }, null).stateLabel).toBe("Suspended");
    expect(
      trayView(stopped, { minimized: ["c"], suspendedTray: ["a"] }, null).stateLabel,
    ).toBe("Hidden");
    // A tray pane that is not actually stopped — woken from outside, say —
    // must not be announced as suspended.
    expect(trayView(panes, { suspendedTray: ["a"] }, null).stateLabel).toBe("Hidden");
  });

  it("partitions the workspace with the grid: every pane is on exactly one of them", () => {
    const cases: [PaneVisibilityView | undefined, string | null][] = [
      [undefined, null],
      [{ minimized: ["a"] }, null],
      [{ suspendedTray: ["b"] }, null],
      [{ minimized: ["a"], suspendedTray: ["a", "c"] }, null],
      [undefined, "b"],
      [{ minimized: ["c"] }, "a"],
    ];
    for (const [view, focusedHere] of cases) {
      const shelved = new Set(trayView(panes, view, focusedHere).entries.map((e) => e.paneId));
      const onGrid = visiblePanes(panes, view).filter(
        (p) => !shelved.has(p.id) && (focusedHere === null || p.id === focusedHere),
      );
      expect(onGrid.length + shelved.size).toBe(panes.length);
    }
  });
});

describe("emptyGridMessage", () => {
  const stopped = [pane("a", true), pane("b", true)];

  it("says what every agent is, in the words the stage used", () => {
    expect(emptyGridMessage(panes, { minimized: ["a", "b", "c"] }).title).toBe(
      "Every agent is minimized",
    );
    expect(emptyGridMessage(stopped, { suspendedTray: ["a", "b"] }).title).toBe(
      "Every agent is suspended",
    );
    // Every agent in the tray, but not every one of them stopped.
    expect(emptyGridMessage([pane("a", true), pane("b")], { suspendedTray: ["a", "b"] }).title).toBe(
      "Every agent is in the tray",
    );
    expect(
      emptyGridMessage(panes, { minimized: ["a", "b"], suspendedTray: ["c"] }).title,
    ).toBe("Every agent is hidden");
    // Some in the tray, the rest minimized by a double mark: nothing is
    // merely minimized, so the tray is what there is to say.
    expect(
      emptyGridMessage(panes, { minimized: ["a"], suspendedTray: ["a", "b", "c"] }).title,
    ).toBe("Every agent is in the tray");
  });

  it("promises 'they keep running' only while nothing is in the tray", () => {
    expect(emptyGridMessage(panes, { minimized: ["a", "b", "c"] }).sub).toBe(
      "They keep running — restore one below to bring it back",
    );
    expect(emptyGridMessage(stopped, { suspendedTray: ["a", "b"] }).sub).toBe(
      "Restore one below to inspect it",
    );
    expect(emptyGridMessage(panes, { minimized: ["a", "b"], suspendedTray: ["c"] }).sub).toBe(
      "Restore one below to inspect it",
    );
  });
});
