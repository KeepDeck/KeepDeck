import { describe, expect, it } from "vitest";
import type { UsageWindow } from "../../domain/usage";
import { usageEvent } from "../../domain/usage/history/event.testSupport";
import { providerWindowGroups } from "../../domain/usage/providerWindows";
import { accountWindowKeys, type WindowReport } from "../../domain/usage/reportJournal";
import { inZone } from "../../domain/usage/time.testSupport";
import { present } from "@keepdeck/plugin-api/testing";
import { limitsChartView } from "./limitsChartView";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (iso: string) => new Date(iso).getTime();
// Sunday 18:19 in Nicosia; the week began Saturday 17:00 and resets the next.
const NOW = at("2026-11-15T18:19:00+02:00");
const WEEK: UsageWindow = { usedPct: 3, resetsAt: at("2026-11-21T17:00:00+02:00"), windowMinutes: 10_080 };
const FIVE_H: UsageWindow = { usedPct: 17, resetsAt: at("2026-11-15T18:49:00+02:00"), windowMinutes: 300 };
const WEEK_RESET = at("2026-11-21T17:00:00+02:00");

function chart(over: { windows?: UsageWindow[]; journal?: WindowReport[]; events?: Parameters<typeof usageEvent>[0][]; measure?: "spend" | "tokens" } = {}) {
  const windows = over.windows ?? [FIVE_H, WEEK];
  const keys = accountWindowKeys("codex", windows);
  const byKey = new Map<string, WindowReport[]>();
  if (over.journal) byKey.set(present(keys.get(WEEK), "the week's key").key, over.journal);
  let view: ReturnType<typeof limitsChartView> = null;
  inZone("Asia/Nicosia", () => {
    const [group] = providerWindowGroups(
      new Map([["codex", { kind: "reported", reportedAt: NOW - 60_000, sourcePaneId: "", windows }]]),
      (over.events ?? []).map((event) => usageEvent({ agent: "codex", ...event })),
      byKey,
      NOW,
      over.measure ?? "spend",
    );
    const rows = group?.rows ?? [];
    const main = rows.find((row) => row.window === WEEK) ?? rows[0];
    if (main) view = limitsChartView(main, rows.filter((row) => row !== main), NOW, over.measure ?? "spend");
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

  it("marks where the provider's 5-hour window runs inside the week", () => {
    const view = present(chart(), "a chart");
    expect(view.slices).toEqual([
      expect.objectContaining({ label: "5h window · 13:49–18:49" }),
    ]);
    const [slice] = view.slices;
    expect((slice?.x1 ?? 0) - (slice?.x0 ?? 0)).toBeCloseTo(5 / (7 * 24));
  });

  it("stands this machine's usage on the same days, the busiest one full height", () => {
    const view = present(
      chart({
        events: [
          { occurredAt: at("2026-11-15T10:00:00+02:00"), costUsd: 4 },
          { occurredAt: at("2026-11-14T20:00:00+02:00"), costUsd: 1 },
          { occurredAt: at("2026-11-14T12:00:00+02:00"), costUsd: 50 }, // before the week began
        ],
      }),
      "a chart",
    );
    expect(view.bars.map((bar) => [bar.height, bar.title])).toEqual([
      [0.25, "Sat, Nov 14, 2026: ≈$1.00"],
      [1, "Sun, Nov 15, 2026: ≈$4.00"],
    ]);
    // Saturday's bar starts where the week does, not at midnight.
    expect(view.bars[0]?.x0).toBe(0);
    expect(view.bars[1]?.x0).toBeCloseTo(7 / (7 * 24));
  });

  it("lays the last windows under this one, each named by its peak and its dates", () => {
    const previousReset = WEEK_RESET - 7 * DAY;
    const journal: WindowReport[] = [
      { agent: "codex", windowMinutes: 10_080, usedPct: 10, reportedAt: previousReset - 6 * DAY, resetsAt: previousReset },
      { agent: "codex", windowMinutes: 10_080, usedPct: 56, reportedAt: previousReset - DAY, resetsAt: previousReset },
      { agent: "codex", windowMinutes: 10_080, usedPct: 3, reportedAt: NOW - HOUR, resetsAt: WEEK.resetsAt },
    ];
    const view = present(chart({ journal }), "a chart");
    expect(view.title).toBe("This window over the last ones");
    expect(view.earlier).toEqual([
      expect.objectContaining({ label: "56% · Nov 7 – Nov 14", latest: true, points: [{ x: 1 / 7, pct: 10 }, { x: 6 / 7, pct: 56 }] }),
    ]);
  });

  it("has no clock to draw on for a window without a span", () => {
    let view: ReturnType<typeof limitsChartView> | undefined;
    inZone("Asia/Nicosia", () => {
      const [group] = providerWindowGroups(
        new Map([["codex", { kind: "reported", reportedAt: NOW, sourcePaneId: "", windows: [{ ...WEEK, resetsAt: null }] }]]),
        [],
        new Map(),
        NOW,
        "spend",
      );
      const row = group?.rows[0];
      if (row) view = limitsChartView(row, [], NOW, "spend");
    });
    expect(view).toBeNull();
  });
});
