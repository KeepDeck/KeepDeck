import { describe, expect, it } from "vitest";
import { TEST_NOW, usageEvent as event } from "./history/event.testSupport";
import { DAY_MS, utcWeekStart, WEEK_MS } from "./time";
import {
  formatWeekLabel,
  usageWeeks,
  weekDaysElapsed,
  weekDeltaCaption,
  weekProgressCaption,
} from "./weeks";

const NOW = TEST_NOW; // 2026-07-22T12:00Z, a Wednesday
const MONDAY = Date.parse("2026-07-20T00:00:00.000Z");

describe("utcWeekStart", () => {
  it("opens every week on UTC Monday 00:00", () => {
    expect(utcWeekStart(NOW)).toBe(MONDAY);
    expect(utcWeekStart(MONDAY)).toBe(MONDAY); // boundary instant stays put
    expect(utcWeekStart(MONDAY - 1)).toBe(MONDAY - WEEK_MS); // Sunday 23:59
    expect(utcWeekStart(Date.parse("2026-07-26T23:59:59.999Z"))).toBe(MONDAY);
  });
});

describe("usageWeeks", () => {
  it("is empty on an empty ledger", () => {
    expect(usageWeeks([], NOW)).toEqual([]);
  });

  it("buckets by UTC week, newest first, and marks the current one", () => {
    const weeks = usageWeeks(
      [
        event({ tokens: { input: 300 } }), // this week
        event({ occurredAt: MONDAY - 1, tokens: { input: 100 } }), // prev week
      ],
      NOW,
    );
    expect(weeks).toHaveLength(2);
    expect(weeks[0]).toMatchObject({
      start: MONDAY,
      totalTokens: 300,
      deltaPct: null, // in progress — never compared to a finished week
      current: true,
    });
    expect(weeks[1]).toMatchObject({
      start: MONDAY - WEEK_MS,
      totalTokens: 100,
      deltaPct: null, // nothing before it to compare against
      current: false,
    });
  });

  it("compares only finished weeks — a Monday morning is not a cliff", () => {
    const weeks = usageWeeks(
      [
        event({ tokens: { input: 1 } }),
        event({ occurredAt: NOW - WEEK_MS, tokens: { input: 300 } }),
        event({ occurredAt: NOW - 2 * WEEK_MS, tokens: { input: 100 } }),
      ],
      NOW,
    );
    expect(weeks[0].deltaPct).toBeNull(); // current, despite a busy prior week
    expect(weeks[1].deltaPct).toBe(200);
  });

  it("keeps quiet weeks as zero rows — the list is continuous", () => {
    const weeks = usageWeeks(
      [
        event({ tokens: { input: 50 } }),
        event({ occurredAt: NOW - 3 * WEEK_MS, tokens: { input: 500 } }),
      ],
      NOW,
    );
    expect(weeks).toHaveLength(4);
    expect(weeks.map((week) => week.totalTokens)).toEqual([50, 0, 0, 500]);
    // A zero week against a used one is -100%; a used week against a zero
    // one has no comparison.
    expect(weeks.map((week) => week.deltaPct)).toEqual([null, null, -100, null]);
  });

  it("splits the bar by agent and crowns the top model by tokens", () => {
    const weeks = usageWeeks(
      [
        event({ tokens: { input: 700 } }), // codex (fixture default)
        event({ agent: "claude", model: "claude-sonnet-5", tokens: { input: 200 } }),
        event({
          agent: "claude",
          model: "small-but-costed",
          tokens: { input: 100 },
          costSource: "provider",
          costUsd: 9,
        }),
      ],
      NOW,
    );
    // Alphabetical roster order, zero agents excluded — the domain owns
    // the bar's membership and order, the view only adds color.
    expect(weeks[0].segments).toEqual([
      { agent: "claude", totalTokens: 300 },
      { agent: "codex", totalTokens: 700 },
    ]);
    // Tokens crown the model — the $9 event must not.
    expect(weeks[0].topModel).toMatchObject({ totalTokens: 700 });
    expect(weeks[0].providerCostUsd).toBe(9);
    expect(weeks[0].costEvents).toBe(1);
  });

  it("keeps an empty week in progress — the view owns its empty state", () => {
    const weeks = usageWeeks(
      [event({ occurredAt: MONDAY - 1, tokens: { input: 100 } })],
      NOW,
    );
    expect(weeks).toHaveLength(2);
    expect(weeks[0]).toMatchObject({
      start: MONDAY,
      totalTokens: 0,
      current: true,
    });
  });

  it("labels a missing OR empty model as the same unknown bucket", () => {
    const weeks = usageWeeks(
      [
        event({ model: undefined, tokens: { input: 100 } }),
        event({ model: "", tokens: { input: 200 } }),
      ],
      NOW,
    );
    expect(weeks[0].topModel).toMatchObject({
      model: "Unknown model",
      totalTokens: 300, // one bucket, not two spellings of unknown
    });
  });

  it("never counts the future — same guard as every stats query", () => {
    const weeks = usageWeeks(
      [
        event({ tokens: { input: 100 } }),
        event({ occurredAt: NOW + DAY_MS, tokens: { input: 9_999 } }),
      ],
      NOW,
    );
    expect(weeks[0].totalTokens).toBe(100);
  });
});

describe("captions", () => {
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

  it("counts the days a week in progress actually has in hand", () => {
    // NOW is the Wednesday: Monday, Tuesday and Wednesday have started.
    expect(weekDaysElapsed(MONDAY, NOW)).toBe(3);
    expect(weekProgressCaption(MONDAY, NOW)).toBe("3 of 7 days");
    // The first instant of the week is already its first day, not its zeroth.
    expect(weekDaysElapsed(MONDAY, MONDAY)).toBe(1);
    // A finished week never reports an eighth day.
    expect(weekDaysElapsed(MONDAY, MONDAY + 20 * DAY_MS)).toBe(7);
  });

  it("phrases the delta with the recap's sign convention, zero flat", () => {
    expect(weekDeltaCaption(18)).toBe("↑ +18%");
    expect(weekDeltaCaption(-41)).toBe("↓ -41%");
    expect(weekDeltaCaption(0)).toBe("0%"); // no arrow on a flat week
    expect(weekDeltaCaption(Math.round(-0.4))).toBe("0%"); // -0 is not UP
    expect(weekDeltaCaption(null)).toBe(""); // an empty cell, never a fake value
  });
});
