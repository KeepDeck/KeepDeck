import { describe, expect, it } from "vitest";
import { TEST_NOW, usageEvent } from "../../domain/usage/history/event.testSupport";
import { statsScopeView } from "./statsScopeView";

const rows = ["A", "B", "C", "D", "E", "F"].map((workspaceName, i) =>
  usageEvent({ occurredAt: TEST_NOW - 60_000, workspaceName, costUsd: 10 - i }),
);
const scope = (workspace: string | null, expanded = false) =>
  statsScopeView(rows, { period: 7, now: TEST_NOW, workspace, expanded });

describe("the workspace scope", () => {
  it("offers every workspace, then the busiest four, the rest behind +N", () => {
    expect(scope(null).chips.map((chip) => [chip.label, chip.active])).toEqual([
      ["All workspaces", true], ["A", false], ["B", false], ["C", false], ["D", false],
    ]);
    expect(scope(null).more).toBe("+2");
  });

  it("keeps a picked workspace on screen even when it is not among the busiest", () => {
    const picked = scope("F");
    expect(picked.chips.map((chip) => [chip.label, chip.active])).toEqual([
      ["All workspaces", false], ["A", false], ["B", false], ["C", false], ["D", false], ["F", true],
    ]);
    expect(picked.more).toBe("+1");
  });

  it("shows them all once opened, with nothing held back", () => {
    expect(scope(null, true).chips).toHaveLength(7);
    expect(scope(null, true).more).toBeNull();
  });

  it("ranks by the period's own usage — a workspace silent in it is held back", () => {
    const old = usageEvent({ occurredAt: TEST_NOW - 400 * 86_400_000, workspaceName: "Old", costUsd: 99 });
    const view = statsScopeView([...rows, old], { period: 7, now: TEST_NOW, workspace: null, expanded: true });
    expect(view.chips.map((chip) => chip.label)).not.toContain("Old");
  });
});
