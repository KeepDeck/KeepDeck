import { describe, expect, it } from "vitest";
import { TEST_NOW, usageEvent as event } from "./history/event.testSupport";
import { DAY_MS } from "./time";
import {
  formatWeekLabel,
  usageWeeks,
  utcWeekStart,
  weekDeltaCaption,
  WEEK_MS,
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
      deltaPct: 200,
      current: true,
    });
    expect(weeks[1]).toMatchObject({
      start: MONDAY - WEEK_MS,
      totalTokens: 100,
      deltaPct: null, // nothing before it to compare against
      current: false,
    });
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
    expect(weeks[0].byAgent).toEqual(
      new Map([
        ["codex", 700],
        ["claude", 300],
      ]),
    );
    // Tokens crown the model — the $9 event must not.
    expect(weeks[0].topModel).toMatchObject({ agent: "codex", totalTokens: 700 });
    expect(weeks[0].providerCostUsd).toBe(9);
    expect(weeks[0].costEvents).toBe(1);
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
  it("labels the week's UTC range, adding the year once it is not now's", () => {
    expect(formatWeekLabel(MONDAY, NOW)).toBe("Jul 20 – Jul 26");
    const lastYear = Date.parse("2025-09-08T00:00:00.000Z"); // a 2025 Monday
    expect(formatWeekLabel(lastYear, NOW)).toBe("Sep 8 – Sep 14 · 2025");
  });

  it("phrases the delta with the recap's sign convention", () => {
    expect(weekDeltaCaption(18)).toBe("↑ +18%");
    expect(weekDeltaCaption(0)).toBe("↑ +0%");
    expect(weekDeltaCaption(-41)).toBe("↓ -41%");
    expect(weekDeltaCaption(null)).toBe("—");
  });
});
