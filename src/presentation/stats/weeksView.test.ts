import { describe, expect, it } from "vitest";
import { emptyCostTally } from "../../domain/usage/history/event";
import { TEST_NOW } from "../../domain/usage/history/event.testSupport";
import { utcWeekStart, WEEK_MS } from "../../domain/usage/time";
import type { UsageWeek } from "../../domain/usage/weeks";
import {
  formatWeekLabel,
  WEEK_IN_PROGRESS,
  weekDeltaCaption,
  weekProgressCaption,
  WEEKS_PAGE,
  weeksPageView,
} from "./weeksView";

const NOW = TEST_NOW; // 2026-07-22T12:00Z, a Wednesday
const MONDAY = Date.parse("2026-07-20T00:00:00.000Z");
const COLORS = new Map([
  ["claude", "#c1"],
  ["codex", "#c2"],
]);

const week = (index: number, over: Partial<UsageWeek> = {}): UsageWeek => ({
  start: MONDAY - index * WEEK_MS,
  totalTokens: 100,
  segments: [{ agent: "codex", totalTokens: 100 }],
  topModel: { model: "GPT-6.1 Sol", totalTokens: 100 },
  ...emptyCostTally(),
  deltaPct: null,
  current: index === 0,
  ...over,
});

describe("week captions", () => {
  it("labels a finished week's UTC range, adding the END's year once it is not now's", () => {
    expect(formatWeekLabel(MONDAY - WEEK_MS, NOW)).toBe("Jul 13 – Jul 19");
    const lastYear = Date.parse("2025-09-08T00:00:00.000Z"); // a 2025 Monday
    expect(formatWeekLabel(lastYear, NOW)).toBe("Sep 8 – Sep 14 · 2025");
    // A New-Year week ends in now's year, so it wears no historical suffix
    // even once it is well behind — the suffix names the END.
    const newYear = Date.parse("2025-12-29T00:00:00.000Z");
    const february = Date.parse("2026-02-10T12:00:00.000Z");
    expect(formatWeekLabel(newYear, february)).toBe("Dec 29 – Jan 4");
  });

  it("names the week in progress by its relation to now, not by its dates", () => {
    // The row used to say "unfinished" by going translucent, which in an
    // interface means disabled — so it said it in the one place a reader
    // cannot mistake for a defect.
    expect(formatWeekLabel(MONDAY, NOW)).toBe("This week");
    expect(formatWeekLabel(utcWeekStart(NOW), NOW)).toBe("This week");
  });

  it("says how many days a week in progress has in hand", () => {
    expect(weekProgressCaption(MONDAY, NOW)).toBe("3 of 7 days");
  });

  it("phrases the delta with the recap's sign convention, zero flat", () => {
    expect(weekDeltaCaption(18)).toBe("↑ +18%");
    expect(weekDeltaCaption(-41)).toBe("↓ -41%");
    expect(weekDeltaCaption(0)).toBe("0%"); // no arrow on a flat week
    expect(weekDeltaCaption(Math.round(-0.4))).toBe("0%"); // -0 is not UP
    expect(weekDeltaCaption(null)).toBe(""); // an empty cell, never a fake value
  });
});

describe("weeksPageView", () => {
  it("shows nothing when there is no week", () => {
    expect(weeksPageView([], 0, NOW, COLORS)).toBeNull();
  });

  it("pages by eight with no pager for a single page", () => {
    const view = weeksPageView([week(0), week(1)], 0, NOW, COLORS);
    expect(view?.rows).toHaveLength(2);
    expect(view?.pager).toBeNull();
    expect(view?.title).toBe("Weeks");
  });

  it("says which weeks a page holds, and where each step of the pager goes", () => {
    const weeks = Array.from({ length: 12 }, (_, index) => week(index));
    const first = weeksPageView(weeks, 0, NOW, COLORS);
    expect(first?.rows).toHaveLength(WEEKS_PAGE);
    expect(first?.pager).toMatchObject({
      range: "1–8 of 12",
      newer: { label: "Newer weeks", to: null },
      older: { label: "Older weeks", to: 1 },
    });
    const last = weeksPageView(weeks, 1, NOW, COLORS);
    expect(last?.rows).toHaveLength(4);
    expect(last?.pager).toMatchObject({ range: "9–12 of 12", newer: { to: 0 }, older: { to: null } });
  });

  it("shows the last page for a page past the end, never an empty one", () => {
    const weeks = Array.from({ length: 9 }, (_, index) => week(index));
    const view = weeksPageView(weeks, 5, NOW, COLORS);
    expect(view?.page).toBe(1);
    expect(view?.rows).toHaveLength(1);
  });

  it("gives the empty week in progress a line instead of zeros", () => {
    const view = weeksPageView([week(0, { totalTokens: 0, segments: [], topModel: null }), week(1)], 0, NOW, COLORS);
    expect(view?.rows[0]).toEqual({ kind: "awaiting", start: MONDAY, label: "This week", line: WEEK_IN_PROGRESS });
  });

  it("tells the week in progress by its days and a finished week by its delta", () => {
    const view = weeksPageView([week(0), week(1, { deltaPct: 18 })], 0, NOW, COLORS);
    const [current, finished] = view?.rows ?? [];
    expect(current).toMatchObject({ kind: "week", rest: true, trend: { kind: "progress", text: "3 of 7 days" } });
    expect(finished).toMatchObject({ kind: "week", rest: false, trend: { kind: "delta", text: "↑ +18%" } });
  });

  it("names the heaviest model with its count, or a dash", () => {
    const view = weeksPageView([week(0), week(1, { topModel: null })], 0, NOW, COLORS);
    expect(view?.rows[0]).toMatchObject({ model: { kind: "model", name: "GPT-6.1 Sol", count: "· 100" } });
    expect(view?.rows[1]).toMatchObject({ model: { kind: "none", text: "—" } });
  });

  it("scales bars against the widest week of every page, never below 2%", () => {
    const weeks = [
      week(0, { totalTokens: 1, segments: [{ agent: "codex", totalTokens: 1 }] }),
      week(1, { totalTokens: 500 }),
      ...Array.from({ length: 8 }, (_, index) => week(index + 2)),
      // On the second page, and the widest of all.
      week(10, { totalTokens: 1_000 }),
    ];
    const view = weeksPageView(weeks, 0, NOW, COLORS);
    const widths = view?.rows.map((row) => (row.kind === "week" ? row.bar?.widthPct : undefined));
    expect(widths?.slice(0, 2)).toEqual([2, 50]);
  });

  it("draws no bar for a week that used nothing", () => {
    const view = weeksPageView([week(0), week(1, { totalTokens: 0, segments: [], topModel: null })], 0, NOW, COLORS);
    expect(view?.rows[1]).toMatchObject({ kind: "week", bar: null });
  });

  it("gives a bar's tip the week and each agent's share in the series colour", () => {
    const view = weeksPageView(
      [
        week(0, {
          totalTokens: 300,
          segments: [
            { agent: "claude", totalTokens: 100 },
            { agent: "codex", totalTokens: 200 },
          ],
        }),
      ],
      0,
      NOW,
      COLORS,
    );
    const row = view?.rows[0];
    expect(row?.kind === "week" ? row.bar : null).toEqual({
      widthPct: 100,
      label: "This week",
      segments: [
        { agent: "claude", tokens: 100, color: "#c1", caption: "claude · 100" },
        { agent: "codex", tokens: 200, color: "#c2", caption: "codex · 200" },
      ],
    });
  });
});
