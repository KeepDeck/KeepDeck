import { describe, expect, it } from "vitest";
import { inZone } from "../../domain/usage/time.testSupport";
import { statsHeaderView, statsPanelView, type StatsHistoryState } from "./statsDialogView";

const history = (over: Partial<StatsHistoryState> = {}): StatsHistoryState => ({
  ready: true,
  error: null,
  hasRows: true,
  periodEvents: 5,
  ...over,
});

describe("statsHeaderView", () => {
  const NOW = Date.parse("2026-11-10T21:45:00+02:00");

  it("offers every calendar period in order with the selected one pressed", () => {
    const view = statsHeaderView("overview", 30, NOW);
    expect(view.periods.map((period) => [period.label, period.active])).toEqual([
      ["Today", false],
      ["7 days", false],
      ["30 days", true],
      ["90 days", false],
      ["All", false],
    ]);
    expect(view.periodIdle).toBe(false);
  });

  it("names the calendar days the period covers", () => {
    inZone("Asia/Nicosia", () => {
      expect(statsHeaderView("overview", 7, NOW).range).toBe("Nov 4 – Nov 10");
      expect(statsHeaderView("overview", 1, NOW).range).toBe("Today, Nov 10");
      expect(statsHeaderView("overview", "all", NOW).range).toBe("All time");
    });
  });

  it("idles the switcher on a tab that never reads it, and says what its numbers run on", () => {
    const view = statsHeaderView("limits", 7, NOW);
    expect(view.periodIdle).toBe(true);
    expect(view.range).toBe("Account-wide · each window runs on its provider's clock");
    expect(statsHeaderView("achievements", 7, NOW).range).toBeNull();
  });

  it("names every tab and marks the selected one", () => {
    expect(statsHeaderView("breakdown", 7, NOW).tabs.map((tab) => [tab.label, tab.active])).toEqual([
      ["Overview", false],
      ["Breakdown", true],
      ["Limits", false],
      ["Achievements", false],
    ]);
  });
});

describe("statsPanelView", () => {
  it("waits while the history loads", () => {
    expect(statsPanelView("overview", history({ ready: false }))).toEqual({
      kind: "loading",
      text: "Loading usage history…",
    });
  });

  it("blocks a ledger tab on a dead ledger, and leaves Limits to its own snapshot", () => {
    const dead = history({ error: "store unreadable", hasRows: false });
    expect(statsPanelView("achievements", dead)).toEqual({
      kind: "unavailable",
      text: "Usage history is unavailable: store unreadable",
    });
    expect(statsPanelView("limits", dead)).toMatchObject({ kind: "tab", tab: "limits", warning: null });
  });

  it("warns above the tab when only some history could be loaded", () => {
    expect(statsPanelView("overview", history({ error: "a newer build's lines" }))).toMatchObject({
      kind: "tab",
      warning: "Some history could not be loaded: a newer build's lines",
    });
  });

  it("says an empty period only for a tab whose whole body is the period", () => {
    const empty = history({ periodEvents: 0 });
    expect(statsPanelView("breakdown", empty)).toEqual({
      kind: "empty",
      warning: null,
      text: "No usage recorded in this period yet.",
    });
    expect(statsPanelView("overview", empty)).toMatchObject({ kind: "tab" });
    expect(statsPanelView("achievements", empty)).toMatchObject({ kind: "tab" });
  });
});
