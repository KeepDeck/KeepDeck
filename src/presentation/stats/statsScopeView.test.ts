import { describe, expect, it } from "vitest";
import { present } from "@keepdeck/plugin-api/testing";
import { TEST_NOW, usageEvent } from "../../domain/usage/history/event.testSupport";
import type { StatsTab } from "../../domain/usage/statsTabs";
import { scopeWorkspace, statsScopeView, type ScopeOptionView } from "./statsScopeView";

/** This week: A spent 6, B 3, C 1; Old spent 50, a year ago. */
const rows = [
  usageEvent({ occurredAt: TEST_NOW - 60_000, workspaceName: "B", costUsd: 3 }),
  usageEvent({ occurredAt: TEST_NOW - 60_000, workspaceName: "A", costUsd: 6 }),
  usageEvent({ occurredAt: TEST_NOW - 60_000, workspaceName: "C", costUsd: 1 }),
  usageEvent({ occurredAt: TEST_NOW - 400 * 86_400_000, workspaceName: "Old", costUsd: 50 }),
];
const scope = (workspace: string | null, tab: StatsTab = "overview") =>
  statsScopeView(rows, { tab, period: 7, now: TEST_NOW, workspace });
const shown = (option: ScopeOptionView) =>
  option.kind === "every" ? [option.name, option.money] : option.kind === "spent" ? [option.name, option.money, option.share] : [option.name, option.note];

describe("the workspace scope", () => {
  it("offers every workspace with the period's total, then each one with usage in it, by spend", () => {
    expect(scope(null).options.map(shown)).toEqual([
      ["All workspaces", "≈$10.00"],
      ["A", "≈$6.00", "60%"],
      ["B", "≈$3.00", "30%"],
      ["C", "≈$1.00", "10%"],
    ]);
    // Old spent nothing this week: not offered, its money not in the total.
    expect(scope(null).options.map((option) => option.name)).not.toContain("Old");
  });

  it("draws each workspace's bar as its share of the period", () => {
    expect(scope(null).options.flatMap((option) => (option.kind === "spent" ? [option.bar] : []))).toEqual([0.6, 0.3, 0.1]);
  });

  it("keeps a picked workspace listed, and says so, when the period holds none of its usage", () => {
    const last = (view: ReturnType<typeof scope>) => shown(present(view.options[view.options.length - 1], "the last option"));
    const view = scope("Old");
    expect(last(view)).toEqual(["Old", "no usage in 7 days"]);
    expect(view.value).toBe("Old");
    expect(last(statsScopeView(rows, { tab: "overview", period: 1, now: TEST_NOW, workspace: "Old" }))).toEqual(["Old", "no usage today"]);
  });

  it("hands back the workspace an option stands for — none for every workspace", () => {
    const view = scope("B");
    expect(view.options.map((option) => scopeWorkspace(option.value))).toEqual([null, "A", "B", "C"]);
    expect(scopeWorkspace(scope(null).value)).toBeNull();
    expect(scopeWorkspace(view.value)).toBe("B");
  });

  it("idles on a tab that never narrows, keeping the pick, with no way back offered there", () => {
    expect(scope("B", "overview")).toMatchObject({ idle: false, clear: "Show every workspace" });
    expect(scope("B", "breakdown").idle).toBe(false);
    for (const tab of ["limits", "weekly", "achievements"] as const) {
      expect(scope("B", tab)).toMatchObject({ idle: true, clear: null, value: "B" });
    }
    // Nothing to clear while every workspace shows.
    expect(scope(null).clear).toBeNull();
  });

  it("says what a pick narrows and what always counts every workspace", () => {
    expect(scope(null).note).toBe("Narrows Overview and Breakdown. Limits, Weekly and Achievements always count every workspace.");
  });
});
