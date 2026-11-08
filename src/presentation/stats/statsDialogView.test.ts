import { describe, expect, it } from "vitest";
import { statsHeaderView, statsPanelView, type StatsHistoryState } from "./statsDialogView";

const history = (over: Partial<StatsHistoryState> = {}): StatsHistoryState => ({
  ready: true,
  error: null,
  hasRows: true,
  periodEvents: 5,
  perModelSince: null,
  firstOccurredAt: 1_000,
  ...over,
});

describe("statsHeaderView", () => {
  it("offers every period in order with the selected one pressed", () => {
    const view = statsHeaderView("overview", 30);
    expect(view.periods.map((period) => [period.label, period.active])).toEqual([
      ["24h", false],
      ["7d", false],
      ["30d", true],
      ["90d", false],
      ["All", false],
    ]);
    expect(view.periodIdle).toBe(false);
  });

  it("idles the switcher on a tab that never reads it", () => {
    expect(statsHeaderView("providers", 7).periodIdle).toBe(true);
  });

  it("names every tab and marks the selected one", () => {
    expect(statsHeaderView("models", 7).tabs.map((tab) => [tab.label, tab.active])).toEqual([
      ["Overview", false],
      ["Providers", false],
      ["Models", true],
      ["Sessions", false],
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

  it("blocks a ledger tab on a dead ledger, and leaves Providers to its own snapshot", () => {
    const dead = history({ error: "store unreadable", hasRows: false });
    expect(statsPanelView("achievements", dead)).toEqual({
      kind: "unavailable",
      text: "Usage history is unavailable: store unreadable",
    });
    expect(statsPanelView("providers", dead)).toMatchObject({ kind: "tab", tab: "providers", warning: null });
  });

  it("warns above the tab when only some history could be loaded", () => {
    expect(statsPanelView("overview", history({ error: "a newer build's lines" }))).toMatchObject({
      kind: "tab",
      warning: "Some history could not be loaded: a newer build's lines",
    });
  });

  it("says an empty period only for a tab whose whole body is the period", () => {
    const empty = history({ periodEvents: 0 });
    expect(statsPanelView("sessions", empty)).toEqual({
      kind: "empty",
      warning: null,
      text: "No usage recorded in this period yet.",
    });
    expect(statsPanelView("overview", empty)).toMatchObject({ kind: "tab" });
    expect(statsPanelView("achievements", empty)).toMatchObject({ kind: "tab" });
  });

  it("titles a table tab by its name, and notes the per-model switch on Models alone", () => {
    const reachingBack = history({ perModelSince: 5_000, firstOccurredAt: 1_000 });
    const models = statsPanelView("models", reachingBack);
    expect(models).toMatchObject({ kind: "tab", title: "Models" });
    expect(models.kind === "tab" ? models.note : null).toMatch(/^Since /);
    expect(statsPanelView("sessions", reachingBack)).toMatchObject({ title: "Sessions", note: null });
  });
});
