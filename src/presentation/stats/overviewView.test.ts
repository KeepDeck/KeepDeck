import { describe, expect, it } from "vitest";
import { usageEvent } from "../../domain/usage/history/event.testSupport";
import { inZone } from "../../domain/usage/time.testSupport";
import type { StatsPeriod } from "../../domain/usage/stats/period";
import { changeView, overviewView } from "./overviewView";

const at = (iso: string) => new Date(iso).getTime();
const NOW = at("2026-11-10T21:00:00+02:00");
const COLORS = new Map([["claude", "#111111"], ["codex", "#222222"]]);

/** Overview over rows, in a fixed zone so the calendar is the test's. */
function view(rows: Parameters<typeof usageEvent>[0][], period: StatsPeriod = 7, workspace: string | null = null) {
  let result: ReturnType<typeof overviewView> | undefined;
  inZone("Asia/Nicosia", () => {
    result = overviewView(rows.map((row) => usageEvent(row)), { period, now: NOW, colors: COLORS, workspace });
  });
  if (result === undefined) throw new Error("no view");
  return result;
}

describe("the Overview headline", () => {
  it("is the period's spend, compared once with the days just before", () => {
    const shown = view([
      { occurredAt: at("2026-11-09T10:00:00+02:00"), costUsd: 80 },
      { occurredAt: at("2026-11-02T10:00:00+02:00"), costUsd: 100 },
    ]);
    expect(shown.spent).toEqual({
      label: "Spent",
      value: "≈$80.00",
      change: { text: "↓ 20%", tone: "good" },
      caption: "vs the 7 days before",
    });
  });

  it("says there is nothing comparable instead of a number it cannot back", () => {
    // Prior spend entirely unpriced: no change, and the caption says why.
    const shown = view([
      { occurredAt: at("2026-11-09T10:00:00+02:00"), costUsd: 80 },
      { occurredAt: at("2026-11-02T10:00:00+02:00"), tokens: { input: 500 } },
    ]);
    expect(shown.spent.change).toBeNull();
    expect(shown.spent.caption).toBe("no comparable period before");
  });

  it("marks a sum with unpriced usage in it, and never prints unknown as free", () => {
    expect(view([
      { occurredAt: at("2026-11-09T10:00:00+02:00"), costUsd: 5 },
      { occurredAt: at("2026-11-09T11:00:00+02:00"), tokens: { input: 10 } },
    ]).spent.value).toBe("≈$5.00+");
    expect(view([{ occurredAt: at("2026-11-09T10:00:00+02:00"), tokens: { input: 10 } }]).spent.value).toBe("—");
  });

  it("compares the whole ledger with nothing", () => {
    const shown = view([{ occurredAt: at("2025-01-01T10:00:00+02:00"), costUsd: 1 }], "all");
    expect(shown.spent.change).toBeNull();
    expect(shown.spent.caption).toBe("all recorded usage");
  });

  it("gives the plain figures with no comparison of their own", () => {
    const shown = view([
      { occurredAt: at("2026-11-09T10:00:00+02:00"), sessionId: "a", tokens: { input: 1, output: 1_500 } },
      { occurredAt: at("2026-11-09T11:00:00+02:00"), sessionId: "b", tokens: { input: 1, output: 500 } },
    ]);
    expect(shown.figures).toEqual([
      { label: "Sessions", value: "2", caption: "with usage in the period" },
      { label: "Output tokens", value: "2k", caption: "reasoning included" },
    ]);
  });
});

describe("a money change", () => {
  it("reads spending less as good, more as bad, and a rounded zero as flat", () => {
    expect(changeView(-0.193)).toEqual({ text: "↓ 19%", tone: "good" });
    expect(changeView(0.5)).toEqual({ text: "↑ 50%", tone: "bad" });
    expect(changeView(0.004)).toEqual({ text: "±0%", tone: "flat" });
  });
});

describe("the Overview lists and legend", () => {
  const day = (hour: number) => at(`2026-11-09T${String(hour).padStart(2, "0")}:00:00+02:00`);

  it("names where and on what the money went, four and a closing row", () => {
    const rows = ["A", "B", "C", "D", "E", "F"].map((workspaceName, i) => ({
      occurredAt: day(i + 1), workspaceName, costUsd: 10 - i,
    }));
    const [workspaces] = view(rows).lists;
    expect(workspaces?.title).toBe("Workspaces");
    expect(workspaces?.rows.map((row) => [row.name, row.cost, row.folded])).toEqual([
      ["A", "≈$10.00", false], ["B", "≈$9.00", false], ["C", "≈$8.00", false], ["D", "≈$7.00", false],
      ["2 more", "≈$11.00", true],
    ]);
  });

  it("tells same-named models apart, with the whole name for a cut-short cell", () => {
    const [, models] = view([
      { occurredAt: day(1), agent: "opencode", model: "zai/glm-5.3", modelName: "GLM-5.3", costUsd: 2 },
      { occurredAt: day(2), agent: "opencode", model: "opencode/glm-5.3", modelName: "GLM-5.3", costUsd: 1 },
    ]).lists;
    expect(models?.rows.map((row) => [row.name, row.source, row.title])).toEqual([
      ["GLM-5.3", "zai", "GLM-5.3 · zai"],
      ["GLM-5.3", "opencode", "GLM-5.3 · opencode"],
    ]);
  });

  it("puts every agent of the period in the legend in a fixed order, unpriced ones as unknown", () => {
    expect(view([
      { occurredAt: day(1), agent: "codex", costUsd: 1 },
      { occurredAt: day(2), agent: "claude", costUsd: 3 },
      { occurredAt: day(3), agent: "kimi", tokens: { input: 5 } },
    ]).legend).toEqual([
      { agent: "claude", color: "#111111", cost: "≈$3.00" },
      { agent: "codex", color: "#222222", cost: "≈$1.00" },
      { agent: "kimi", color: "#596273", cost: "—" },
    ]);
  });

  it("steps by hour for today and by day otherwise", () => {
    const rows = [{ occurredAt: day(1), costUsd: 1 }];
    // Today runs 00:00 through the current hour, a quiet one included.
    const today = view(rows, 1).chart;
    expect(today?.title).toBe("Spend per hour");
    expect(today?.steps).toHaveLength(22);
    expect(today?.steps.every((step) => step.costUsd === 0)).toBe(true);
    expect(view(rows, 7).chart?.steps).toHaveLength(7);
    expect(view(rows, 7).chart?.title).toBe("Spend per day");
  });
});

describe("an Overview narrowed to one workspace", () => {
  it("counts that workspace alone, and lists its agents instead of repeating the scope", () => {
    const rows = [
      { occurredAt: at("2026-11-09T10:00:00+02:00"), workspaceName: "KeepDeck", agent: "claude", costUsd: 4 },
      { occurredAt: at("2026-11-09T11:00:00+02:00"), workspaceName: "KeepDeck", agent: "codex", costUsd: 1 },
      { occurredAt: at("2026-11-09T12:00:00+02:00"), workspaceName: "Docs", costUsd: 50 },
    ];
    const shown = view(rows, 7, "KeepDeck");
    expect(shown.spent.value).toBe("≈$5.00");
    expect(shown.lists[0]?.title).toBe("Agents");
    expect(shown.lists[0]?.rows.map((row) => row.name)).toEqual(["claude", "codex"]);
    expect(view(rows).lists[0]?.title).toBe("Workspaces");
  });
});
