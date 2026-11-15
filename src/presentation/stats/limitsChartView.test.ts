import { describe, expect, it } from "vitest";
import type { UsageWindow } from "../../domain/usage";
import { usageEvent } from "../../domain/usage/history/event.testSupport";
import { providerWindowGroups } from "../../domain/usage/providerWindows";
import { accountWindowKeys, type WindowReport } from "../../domain/usage/reportJournal";
import { inZone } from "../../domain/usage/time.testSupport";
import { present } from "@keepdeck/plugin-api/testing";
import { limitsChartView, limitsTooltipView } from "./limitsChartView";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (iso: string) => new Date(iso).getTime();
// Sunday 18:19 in Nicosia; the week began Saturday 17:00 and resets the next.
const NOW = at("2026-11-15T18:19:00+02:00");
const WEEK: UsageWindow = { usedPct: 3, resetsAt: at("2026-11-21T17:00:00+02:00"), windowMinutes: 10_080 };
const FIVE_H: UsageWindow = { usedPct: 17, resetsAt: at("2026-11-15T18:49:00+02:00"), windowMinutes: 300 };
const WEEK_RESET = at("2026-11-21T17:00:00+02:00");

function chart(over: { windows?: UsageWindow[]; journal?: WindowReport[]; events?: Parameters<typeof usageEvent>[0][] } = {}) {
  const windows = over.windows ?? [FIVE_H, WEEK];
  const keys = accountWindowKeys("codex", windows);
  const byKey = new Map<string, WindowReport[]>();
  const week = windows.find((window) => window.windowMinutes === WEEK.windowMinutes);
  if (over.journal && week) byKey.set(present(keys.get(week), "the week's key").key, over.journal);
  let view: ReturnType<typeof limitsChartView> = null;
  inZone("Asia/Nicosia", () => {
    const [group] = providerWindowGroups(
      new Map([["codex", { kind: "reported", reportedAt: NOW - 60_000, sourcePaneId: "", windows }]]),
      (over.events ?? []).map((event) => usageEvent({ agent: "codex", ...event })),
      byKey,
      NOW,
    );
    const rows = group?.rows ?? [];
    const main = rows.find((row) => row.window === WEEK) ?? rows[0];
    if (main) view = limitsChartView(main, NOW);
  });
  return view as ReturnType<typeof limitsChartView>;
}

describe("the Limits chart", () => {
  it("names the window's start, its reset and now on the reader's calendar", () => {
    const view = present(chart(), "a chart");
    expect([view.start, view.end, view.now.label]).toEqual(["started Nov 14, 17:00", "resets Nov 21, 17:00", "now · Nov 15, 18:19"]);
    expect(view.now.x).toBeCloseTo((NOW - (WEEK_RESET - 7 * DAY)) / (7 * DAY));
  });

  it("cuts the week at local midnights, and names each day wide enough to carry one", () => {
    const view = present(chart(), "a chart");
    // Seven midnights inside a week that starts at 17:00.
    expect(view.grid).toHaveLength(7);
    expect(view.grid[0]).toBeCloseTo(7 / (7 * 24));
    // The seven-hour sliver of Saturday carries no name; every whole day does.
    expect(view.ticks.map((tick) => tick.label)).toEqual(["Nov 15", "Nov 16", "Nov 17", "Nov 18", "Nov 19", "Nov 20", "Nov 21"]);
  });

  it("puts a 5h window on its own clock, by the hour", () => {
    const view = present(chart({ windows: [FIVE_H] }), "a chart");
    expect([view.start, view.end]).toEqual(["started Nov 15, 13:49", "resets Nov 15, 18:49"]);
    expect(view.ticks.map((tick) => tick.label)).toEqual(["14:00", "15:00", "16:00", "17:00", "18:00"]);
  });

  it("stands this machine's usage on the same days, the busiest one full height", () => {
    const view = present(
      chart({
        events: [
          { occurredAt: at("2026-11-15T10:00:00+02:00"), costUsd: 1, tokens: { input: 4_000 } },
          // Dear but small: money does not size a bar.
          { occurredAt: at("2026-11-14T20:00:00+02:00"), costUsd: 90, tokens: { input: 1_000, cacheRead: 50_000 } },
          { occurredAt: at("2026-11-14T12:00:00+02:00"), tokens: { input: 50_000 } }, // before the week began
        ],
      }),
      "a chart",
    );
    // Tokens, not money: a limit counts work. The busiest day is full height.
    expect(view.bars.map((bar) => [bar.height, bar.title])).toEqual([
      [0.25, "Sat, Nov 14, 2026: 1k tokens"],
      [1, "Sun, Nov 15, 2026: 4k tokens"],
    ]);
    // Saturday's bar starts where the week does, not at midnight.
    expect(view.bars[0]?.x0).toBe(0);
    expect(view.bars[1]?.x0).toBeCloseTo(7 / (7 * 24));
  });

  it("names where the pace takes the window: the limit and when, or what is left at the reset", () => {
    // A steep climb: 3% to 13% over the last six hours of reports.
    const steep: WindowReport[] = [0, 2, 4, 6].map((hours, index) => ({
      agent: "codex", windowMinutes: 10_080, usedPct: 3 + index * 3.4, reportedAt: NOW - (6 - hours) * HOUR, resetsAt: WEEK_RESET,
    }));
    const out = present(chart({ windows: [{ ...WEEK, usedPct: 13.2 }], journal: steep }), "a chart").current.end;
    expect(out).toMatchObject({ pct: 100, side: "after", below: true, className: "usage-level--warn" });
    expect(out?.label).toMatch(/^limit ~/);
    // A gentle one ends at the reset with its headroom.
    const gentle: WindowReport[] = [0, 2, 4, 6].map((hours, index) => ({
      agent: "codex", windowMinutes: 10_080, usedPct: 3 + index * 0.1, reportedAt: NOW - (6 - hours) * HOUR, resetsAt: WEEK_RESET,
    }));
    const lasts = present(chart({ windows: [{ ...WEEK, usedPct: 3.3 }], journal: gentle }), "a chart").current.end;
    expect(lasts).toMatchObject({ x: 1, side: "before" });
    expect(lasts?.label).toMatch(/^~\d+% left at reset$/);
  });

  it("keeps the now label inside the plot: before the line near the right edge, after it elsewhere", () => {
    const view = present(chart(), "a chart");
    // Now, a day in: its name follows the line.
    expect(view.now.side).toBe("after");
    // Near the reset it goes before the line, not past the edge.
    expect(present(chart({ windows: [{ ...FIVE_H, resetsAt: NOW + 10 * 60_000 }] }), "a chart").now.side).toBe("before");
  });


  it("stands a lone reading where it was read, not at now", () => {
    let view: ReturnType<typeof limitsChartView> = null;
    inZone("Asia/Nicosia", () => {
      const [group] = providerWindowGroups(
        new Map([["codex", { kind: "reported", reportedAt: NOW - 3 * HOUR, sourcePaneId: "", windows: [WEEK] }]]),
        [],
        new Map(),
        NOW,
      );
      const row = group?.rows[0];
      if (row) view = limitsChartView(row, NOW);
    });
    const chartView = present(view as ReturnType<typeof limitsChartView>, "a chart");
    const x = (NOW - 3 * HOUR - (WEEK_RESET - 7 * DAY)) / (7 * DAY);
    expect(chartView.current.geometry.observed).toEqual([{ x, y: 0.03, at: NOW - 3 * HOUR, usedPct: 3 }]);
    expect(chartView.current.geometry.projected).toBeNull();
    // And says it is the only one.
    expect(chartView.current.lone).toEqual({ x, pct: 3, label: "1 report so far", side: "after" });
    // No usage on this machine: no bars, not a row of empty ones.
    expect(chartView.bars).toEqual([]);
  });

  it("dates the instant under inspection, and says this machine's usage on that day while there is one", () => {
    const view = present(
      chart({ events: [{ occurredAt: at("2026-11-15T10:00:00+02:00"), tokens: { input: 4_000 } }] }),
      "a chart",
    );
    inZone("Asia/Nicosia", () => {
      const sunday = { x: 0.15, y: 0.03, at: at("2026-11-15T12:00:00+02:00"), usedPct: 3, kind: "observed" as const };
      expect(limitsTooltipView(view, sunday)).toEqual({
        kind: "observed", label: "Nov 15, 12:00", source: "Observed", value: "3% used", note: "This machine that day: 4k tokens",
      });
      // A projected Thursday has no usage yet: nothing is said of it.
      const thursday = { x: 0.7, y: 0.4, at: at("2026-11-19T12:00:00+02:00"), usedPct: 40, kind: "projected" as const };
      expect(limitsTooltipView(view, thursday)).toMatchObject({ label: "Nov 19, 12:00", source: "Projected", note: null });
    });
  });

  it("reads the last step at the plot's right edge, where it ends at the reset", () => {
    // Now is in the 5h window's last hour: its last step runs to the reset.
    const view = present(chart({ windows: [FIVE_H], events: [{ occurredAt: NOW - 10 * 60_000, tokens: { input: 900 } }] }), "a chart");
    const last = view.bars[view.bars.length - 1];
    expect(last?.x1).toBe(1);
    inZone("Asia/Nicosia", () => {
      const edge = { x: 1, y: 0.2, at: FIVE_H.resetsAt ?? 0, usedPct: 20, kind: "projected" as const };
      expect(limitsTooltipView(view, edge).note).toBe("This machine that hour: 900 tokens");
    });
  });

  it("names every n-th day of a long window rather than none", () => {
    const month: UsageWindow = { usedPct: 10, resetsAt: NOW + 20 * DAY, windowMinutes: 30 * 24 * 60 };
    const view = present(chart({ windows: [month] }), "a chart");
    expect(view.grid.length).toBeGreaterThan(28);
    expect(view.ticks.length).toBeGreaterThan(5);
    expect(view.ticks.length).toBeLessThanOrEqual(10);
  });

  it("has no clock to draw on for a window without a span", () => {
    let view: ReturnType<typeof limitsChartView> | undefined;
    inZone("Asia/Nicosia", () => {
      const [group] = providerWindowGroups(
        new Map([["codex", { kind: "reported", reportedAt: NOW, sourcePaneId: "", windows: [{ ...WEEK, resetsAt: null }] }]]),
        [],
        new Map(),
        NOW,
      );
      const row = group?.rows[0];
      if (row) view = limitsChartView(row, NOW);
    });
    expect(view).toBeNull();
  });
});
