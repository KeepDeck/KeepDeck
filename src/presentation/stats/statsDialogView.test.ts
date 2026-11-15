import { describe, expect, it } from "vitest";
import { TEST_NOW, usageEvent } from "../../domain/usage/history/event.testSupport";
import { inZone } from "../../domain/usage/time.testSupport";
import { statsHeaderView, statsPanelView, type StatsHistoryState } from "./statsDialogView";

/** A ledger with one row a moment ago — in this period, in workspace A. */
const ROWS = [usageEvent({ occurredAt: TEST_NOW - 60_000, workspaceName: "A" })];
const SCOPE = { period: 7 as const, now: TEST_NOW, workspace: null };
const history = (over: Partial<StatsHistoryState> = {}): StatsHistoryState => ({
  ready: true,
  error: null,
  rows: ROWS,
  ...over,
});

describe("statsHeaderView", () => {
  const NOW = Date.parse("2026-11-10T21:45:00+02:00");

  it("offers every calendar period in order with the selected one pressed", () => {
    const view = statsHeaderView("overview", 30, NOW, "spend");
    expect(view.period.label).toBe("Statistics period");
    expect(view.period.choices.map((period) => [period.label, period.active, period.value])).toEqual([
      ["Today", false, 1],
      ["7 days", false, 7],
      ["30 days", true, 30],
      ["90 days", false, 90],
      ["All", false, "all"],
    ]);
    expect(view.period.idle).toBe(false);
  });

  it("offers what the numbers count first, idle only where a tab counts in neither", () => {
    const view = statsHeaderView("overview", 7, NOW, "tokens");
    expect(view.measure.choices.map((choice) => [choice.label, choice.active, choice.value])).toEqual([
      ["Spend", false, "spend"],
      ["Tokens", true, "tokens"],
    ]);
    expect(view.measure.idle).toBe(false);
    // Badges count by their own rules: the choice stands, idle.
    expect(statsHeaderView("achievements", 7, NOW, "tokens").measure).toMatchObject({ idle: true });
    // Limits are the provider's percent, and its bars count tokens: idle too.
    expect(statsHeaderView("limits", 7, NOW, "spend").measure).toMatchObject({ idle: true });
  });

  it("names the calendar days the period covers", () => {
    inZone("Asia/Nicosia", () => {
      expect(statsHeaderView("overview", 7, NOW, "spend").range).toBe("Nov 4 – Nov 10");
      expect(statsHeaderView("overview", 1, NOW, "spend").range).toBe("Today, Nov 10");
      expect(statsHeaderView("overview", "all", NOW, "spend").range).toBe("All time");
    });
  });

  it("idles the switcher on a tab that never reads it, and says what its numbers run on", () => {
    const view = statsHeaderView("limits", 7, NOW, "spend");
    expect(view.period.idle).toBe(true);
    expect(view.range).toBe("Account-wide · each window runs on its provider's clock");
    expect(statsHeaderView("achievements", 7, NOW, "spend")).toMatchObject({ period: { idle: true }, range: "All time · all workspaces" });
  });

  it("names every tab and marks the selected one", () => {
    expect(statsHeaderView("breakdown", 7, NOW, "spend").tabs.map((tab) => [tab.label, tab.active])).toEqual([
      ["Overview", false],
      ["Breakdown", true],
      ["Limits", false],
      ["Weekly", false],
      ["Achievements", false],
    ]);
  });
});

describe("statsPanelView", () => {
  it("waits while the history loads", () => {
    expect(statsPanelView("overview", history({ ready: false }), SCOPE)).toEqual({
      kind: "loading",
      text: "Loading usage history…",
    });
  });

  it("blocks a ledger tab on a dead ledger, and leaves Limits to its own snapshot", () => {
    const dead = history({ error: "store unreadable", rows: [] });
    expect(statsPanelView("achievements", dead, SCOPE)).toEqual({
      kind: "unavailable",
      text: "Usage history is unavailable: store unreadable",
    });
    expect(statsPanelView("limits", dead, SCOPE)).toMatchObject({ kind: "tab", tab: "limits", warning: null });
  });

  it("warns above the tab when only some history could be loaded", () => {
    expect(statsPanelView("overview", history({ error: "a newer build's lines" }), SCOPE)).toMatchObject({
      kind: "tab",
      warning: "Some history could not be loaded: a newer build's lines",
    });
  });

  it("says an empty period only for a tab whose whole body is the period", () => {
    // Nothing in the last 7 days: one row, a year back.
    const empty = history({ rows: [usageEvent({ occurredAt: TEST_NOW - 400 * 86_400_000 })] });
    expect(statsPanelView("breakdown", empty, SCOPE)).toEqual({
      kind: "empty",
      warning: null,
      text: "No usage recorded in this period yet.",
    });
    expect(statsPanelView("overview", empty, SCOPE)).toMatchObject({ kind: "tab" });
    expect(statsPanelView("achievements", empty, SCOPE)).toMatchObject({ kind: "tab" });
  });
});

describe("an empty period inside a workspace", () => {
  it("is judged where the tab looks — inside the workspace it narrows to", () => {
    const elsewhere = { ...SCOPE, workspace: "B" };
    expect(statsPanelView("breakdown", history(), elsewhere)).toMatchObject({ kind: "empty" });
    expect(statsPanelView("breakdown", history(), { ...SCOPE, workspace: "A" })).toMatchObject({ kind: "tab" });
  });
});
