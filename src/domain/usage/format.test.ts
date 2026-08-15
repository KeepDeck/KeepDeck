import { describe, expect, it } from "vitest";
import {
  chipWindows,
  contextLevel,
  formatAge,
  formatBucket,
  formatCountdown,
  formatMoment,
  formatPct,
  formatTimestamp,
  formatTokens,
  formatUsd,
  limitLevel,
  panelWindows,
  tokenBreakdown,
  tokenSegments,
  usageStale,
  windowLabel,
  windowLevel,
  windowResetCaption,
} from "./format";
import type { AccountUsage, UsageWindow } from "./usage";

const account = (windows: UsageWindow[]): AccountUsage => ({
  kind: "reported",
  windows,
  reportedAt: 0,
  sourcePaneId: "",
});

const FIVE_H = { usedPct: 10, resetsAt: null, windowMinutes: 300 };
const WEEKLY = { usedPct: 20, resetsAt: null, windowMinutes: 10_080 };
const PLAN = { usedPct: 30, resetsAt: null, windowMinutes: null };
const QUOTA = { usedPct: 40, resetsAt: null, windowMinutes: null, scope: "quota" };

describe("chipWindows / panelWindows", () => {
  it("gives the chip up to two account-wide windows, shortest first", () => {
    expect(chipWindows(account([QUOTA, PLAN, WEEKLY, FIVE_H]))).toEqual([
      FIVE_H,
      WEEKLY,
    ]);
    expect(chipWindows(account([PLAN]))).toEqual([PLAN]);
  });

  it("gives the panel everything, scoped windows last", () => {
    expect(panelWindows(account([QUOTA, WEEKLY, FIVE_H]))).toEqual([
      FIVE_H,
      WEEKLY,
      QUOTA,
    ]);
  });

  it("yields nothing for a non-reported account", () => {
    const unavailable: AccountUsage = {
      kind: "unavailable",
      reason: "api-key",
      reportedAt: 0,
    };
    expect(chipWindows(unavailable)).toEqual([]);
    expect(panelWindows(unavailable)).toEqual([]);
  });
});

describe("levels", () => {
  it("account windows go amber at 60 and red at 80", () => {
    expect(limitLevel(59.9)).toBe("ok");
    expect(limitLevel(60)).toBe("warn");
    expect(limitLevel(79.9)).toBe("warn");
    expect(limitLevel(80)).toBe("critical");
  });

  it("context goes amber at 75 and red at 90", () => {
    expect(contextLevel(74)).toBe("ok");
    expect(contextLevel(75)).toBe("warn");
    expect(contextLevel(90)).toBe("critical");
  });
});

describe("windowLabel", () => {
  it("labels by length, falling back to scope", () => {
    expect(windowLabel({ usedPct: 0, resetsAt: null, windowMinutes: 300 })).toBe("5h");
    expect(windowLabel({ usedPct: 0, resetsAt: null, windowMinutes: 1440 })).toBe("day");
    expect(windowLabel({ usedPct: 0, resetsAt: null, windowMinutes: 10_080 })).toBe("wk");
    expect(windowLabel({ usedPct: 0, resetsAt: null, windowMinutes: 43_200 })).toBe("mo");
    expect(
      windowLabel({ usedPct: 0, resetsAt: null, windowMinutes: 10_080 }, "long"),
    ).toBe("week");
    expect(
      windowLabel({ usedPct: 0, resetsAt: null, windowMinutes: 43_200 }, "long"),
    ).toBe("month");
    expect(
      windowLabel({
        usedPct: 0,
        resetsAt: null,
        windowMinutes: null,
        scope: "seven_day_fable",
      }),
    ).toBe("seven_day_fable");
    expect(windowLabel({ usedPct: 0, resetsAt: null, windowMinutes: null })).toBe("plan");
  });
});

describe("formatCountdown", () => {
  const NOW = 1_000_000_000_000;
  it("scales through minutes, hours and days", () => {
    expect(formatCountdown(NOW + 30_000, NOW)).toBe("1m");
    expect(formatCountdown(NOW + 45 * 60_000, NOW)).toBe("45m");
    expect(formatCountdown(NOW + 130 * 60_000, NOW)).toBe("2h 10m");
    expect(formatCountdown(NOW + 50 * 3_600_000, NOW)).toBe("2d 2h");
  });

  it("is null for unknown or passed resets", () => {
    expect(formatCountdown(null, NOW)).toBeNull();
    expect(formatCountdown(NOW, NOW)).toBeNull();
    expect(formatCountdown(NOW - 1, NOW)).toBeNull();
  });
});

describe("formatPct", () => {
  it("runs in the direction the user picked", () => {
    expect(formatPct(41.6, "used")).toBe("42%");
    expect(formatPct(41.6, "left")).toBe("58% left");
  });

  it("ceils used like the CLIs' own panels — never understates", () => {
    expect(formatPct(4.2, "used")).toBe("5%");
    expect(formatPct(4.2, "left")).toBe("95% left");
    expect(formatPct(100, "used")).toBe("100%");
  });
});

describe("windowLevel", () => {
  const NOW = 1_000_000_000_000;
  it("grants threshold color only to live windows past the thresholds", () => {
    expect(windowLevel({ usedPct: 59, resetsAt: null, windowMinutes: 300 }, NOW)).toBeNull();
    expect(windowLevel({ usedPct: 65, resetsAt: null, windowMinutes: 300 }, NOW)).toBe("warn");
    expect(windowLevel({ usedPct: 90, resetsAt: null, windowMinutes: 300 }, NOW)).toBe("critical");
    // An expired window's % describes the PREVIOUS window: never colored.
    expect(
      windowLevel({ usedPct: 90, resetsAt: NOW - 1, windowMinutes: 300 }, NOW),
    ).toBeNull();
  });
});

describe("windowResetCaption", () => {
  const NOW = 1_000_000_000_000;
  it("splits the expired caption by surface, both on purpose", () => {
    const expired = { usedPct: 1, resetsAt: NOW - 1, windowMinutes: 300 };
    expect(windowResetCaption(expired, NOW)).toBe(""); // popover stays quiet
    // Just the fact. WHY the percentage is stale is the card's to say, once
    // above its windows — repeated under each of them it turned a card with
    // nothing to report into several grey lines about the same absence.
    expect(windowResetCaption(expired, NOW, "long")).toBe("reset passed");
  });

  it("covers all four window kinds", () => {
    // An expired window has no caption — the dimmed % already reads as stale.
    expect(
      windowResetCaption({ usedPct: 1, resetsAt: NOW - 1, windowMinutes: 300 }, NOW),
    ).toBe("");
    expect(
      windowResetCaption(
        { usedPct: 1, resetsAt: NOW + 130 * 60_000, windowMinutes: 300 },
        NOW,
      ),
    ).toBe("resets in 2h 10m");
    expect(
      windowResetCaption({ usedPct: 1, resetsAt: null, windowMinutes: 300 }, NOW),
    ).toBe("reset unknown");
    expect(
      windowResetCaption(
        { usedPct: 1, resetsAt: null, windowMinutes: null, scope: "quota" },
        NOW,
      ),
    ).toBe("plan allowance");
  });
});

describe("staleness and age", () => {
  const NOW = 1_000_000_000_000;
  it("demotes reports after the stale threshold", () => {
    expect(usageStale(NOW - 29 * 60_000, NOW)).toBe(false);
    expect(usageStale(NOW - 31 * 60_000, NOW)).toBe(true);
  });

  it("formats coarse ages", () => {
    expect(formatAge(NOW - 5000, NOW)).toBe("now");
    expect(formatAge(NOW - 3 * 60_000, NOW)).toBe("3m ago");
    expect(formatAge(NOW - 2 * 3_600_000, NOW)).toBe("2h ago");
  });

  it("drops only the suffix in the bare form — thresholds never fork", () => {
    expect(formatAge(NOW - 5000, NOW, "bare")).toBe("now");
    expect(formatAge(NOW - 3 * 60_000, NOW, "bare")).toBe("3m");
    expect(formatAge(NOW - 2 * 86_400_000, NOW, "bare")).toBe("2d");
  });
});

describe("formatTimestamp", () => {
  // Local-calendar instants, so the suite holds in any timezone.
  const at = (y: number, m: number, d: number, h = 0, min = 0) =>
    new Date(y, m - 1, d, h, min).getTime();

  it("today's entries show the clock time", () => {
    expect(formatTimestamp(at(2026, 8, 15, 14, 32), at(2026, 8, 15, 20, 0))).toBe(
      "14:32",
    );
    // Midnight is the boundary, not midnight-ish: the same calendar day
    // keeps the clock even at 00:01.
    expect(formatTimestamp(at(2026, 8, 15, 0, 1), at(2026, 8, 15, 23, 59))).toBe(
      "00:01",
    );
  });

  it("older entries show the plain date, zero-padded", () => {
    expect(formatTimestamp(at(2026, 8, 14, 22, 0), at(2026, 8, 15, 0, 1))).toBe(
      "14.08",
    );
    expect(formatTimestamp(at(2026, 7, 31, 9, 0), at(2026, 8, 1, 9, 0))).toBe(
      "31.07",
    );
    expect(formatTimestamp(at(2026, 3, 5, 9, 0), at(2026, 3, 6, 9, 0))).toBe(
      "05.03",
    );
  });
});

describe("formatBucket", () => {
  const AT = Date.parse("2026-07-22T14:00:00.000Z");
  it("labels hour buckets in UTC — the buckets themselves are UTC-aligned", () => {
    // In a :30/:45-offset zone a local rendering would read "19:30" for a
    // UTC-hour bucket; the label speaks the bucket's own clock instead.
    expect(formatBucket(AT, "hour")).toBe("14:00");
    expect(formatBucket(AT, "hour", "long")).toBe("Jul 22, 14:00 UTC");
    expect(formatBucket(Date.parse("2026-07-22T00:00:00.000Z"), "hour")).toBe(
      "00:00",
    );
  });

  it("labels day buckets as UTC days, dated fully in the long form", () => {
    expect(formatBucket(AT, "day")).toBe("Jul 22");
    expect(formatBucket(AT, "day", "long")).toBe("Jul 22, 2026");
  });
});

describe("formatUsd", () => {
  it("rounds before choosing the format, so the grouping boundary holds", () => {
    expect(formatUsd(999.99)).toBe("$999.99");
    expect(formatUsd(999.995)).toBe("$1,000"); // toFixed would say "1000.00"
    expect(formatUsd(1_000)).toBe("$1,000");
    expect(formatUsd(5258.27)).toBe("$5,258");
  });

  it("never renders a positive amount as free", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.00004)).toBe("<$0.0001"); // toFixed(4) would say $0.0000
    expect(formatUsd(0.0004)).toBe("$0.0004");
    expect(formatUsd(0.25, { approx: true })).toBe("≈$0.25");
  });
});

describe("formatTokens", () => {
  it("keeps sub-thousand counts exact", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(812)).toBe("812");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1499.6)).toBe("1.5k"); // rounds at the thousands scale
  });

  it("abbreviates thousands and millions, dropping a whole-number decimal", () => {
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(15_500)).toBe("15.5k");
    expect(formatTokens(262_144)).toBe("262.1k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(1_048_576)).toBe("1M");
  });

  it("promotes k→M at the boundary so nothing renders as 1000k", () => {
    expect(formatTokens(999_000)).toBe("999k");
    expect(formatTokens(999_999)).toBe("1M");
  });

  it("abbreviates billions past the M boundary", () => {
    expect(formatTokens(1_200_000_000)).toBe("1.2B");
    expect(formatTokens(5_044_500_000)).toBe("5B");
    expect(formatTokens(123_456_000_000)).toBe("123.5B");
  });

  it("promotes M→B at the boundary so nothing renders as 1000M", () => {
    expect(formatTokens(999_000_000)).toBe("999M");
    expect(formatTokens(999_949_999)).toBe("999.9M");
    expect(formatTokens(999_950_000)).toBe("1B");
  });

  it("promotes B→T at the boundary — the ladder names a trillion", () => {
    expect(formatTokens(999_000_000_000)).toBe("999B");
    expect(formatTokens(999_950_000_000)).toBe("1T");
    expect(formatTokens(1e12)).toBe("1T");
    expect(formatTokens(2_340_000_000_000)).toBe("2.3T");
  });

  it("is 0 for non-finite or negative input", () => {
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("formatMoment", () => {
  // A local wall clock, on purpose — unlike every other label in this file.
  // Built from a local midnight so the case is stable in any zone the suite
  // runs in.
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const midnight = new Date(2026, 6, 22, 0, 0, 0, 0).getTime();
  const at = (dayOffset: number, hour: number, minute = 0) =>
    midnight + dayOffset * DAY + hour * HOUR + minute * MIN;
  const NOON = at(0, 12);

  it("says only the clock for a moment later today", () => {
    expect(formatMoment(at(0, 17, 11), NOON)).toBe("17:11");
    // 24-hour, zero-padded — and midnight is 00:00, never 24:00.
    expect(formatMoment(at(0, 0), NOON)).toBe("00:00");
    expect(formatMoment(at(0, 9, 5), NOON)).toBe("09:05");
  });

  it("names tomorrow by its relation, not by its date", () => {
    // "tomorrow 06:40" places a moment that "Jul 23, 06:40" makes the
    // reader work out.
    expect(formatMoment(at(1, 6, 40), NOON)).toBe("tomorrow 06:40");
    // The boundary is the calendar day, not 24 hours: 01:00 tomorrow is
    // thirteen hours away and still "tomorrow".
    expect(formatMoment(at(1, 1), NOON)).toBe("tomorrow 01:00");
  });

  it("names the weekday inside the week ahead", () => {
    expect(formatMoment(at(2, 6, 40), NOON)).toBe("Fri 06:40");
    expect(formatMoment(at(6, 6, 40), NOON)).toBe("Tue 06:40");
  });

  it("falls back to a date once the weekday would be ambiguous", () => {
    // Seven days out, "Wed" would name the same weekday as today.
    expect(formatMoment(at(7, 6, 40), NOON)).toBe("Jul 29, 06:40");
    expect(formatMoment(at(40, 6, 40), NOON)).toBe("Aug 31, 06:40");
  });

  it("renders a past instant as a bare clock, which is its known limit", () => {
    // Every caller today passes a FUTURE instant by construction (a reset
    // or a run-out), so this is a documented edge rather than a live bug —
    // but it means the function cannot be reused for "last reported at"
    // without a yesterday branch.
    expect(formatMoment(at(-1, 8), NOON)).toBe("08:00");
    expect(formatMoment(at(0, 8), NOON)).toBe("08:00");
  });
});

describe("tokenSegments", () => {
  it("carries each part's raw value, so a bar can be drawn to scale", () => {
    // The caption alone forces arithmetic on the reader: "cache 323.7M · ↑
    // 7.4k" is 98% cache, and nothing about the sentence says so.
    expect(tokenSegments({ cacheRead: 323_700_000, input: 7_400, output: 932_100 }))
      .toEqual([
        { kind: "cache", caption: "cache 323.7M", value: 323_700_000 },
        { kind: "input", caption: "↑ 7.4k", value: 7_400 },
        { kind: "output", caption: "↓ 932.1k", value: 932_100 },
      ]);
  });

  it("is the one home for which kinds show and in what order", () => {
    // The text line and the proportion bar read from this, so they cannot
    // disagree about a part being present.
    expect(tokenSegments({ input: 5 }).map((part) => part.kind)).toEqual([
      "input",
    ]);
    expect(tokenSegments({}).length).toBe(0);
  });
});

describe("tokenBreakdown", () => {
  it("leads with cache, the term that usually is most of the total", () => {
    expect(
      tokenBreakdown({ input: 240_000_000, output: 80_000_000, cacheRead: 1.68e9 }),
    ).toBe("cache 1.7B · ↑ 240M · ↓ 80M");
  });

  it("omits a field the provider never reported, rather than claiming a zero", () => {
    // codex reports no cache split; printing "cache 0" would state something
    // it did not say.
    expect(tokenBreakdown({ input: 1_000, output: 100 })).toBe("↑ 1k · ↓ 100");
    expect(tokenBreakdown({ cacheRead: 500 })).toBe("cache 500");
  });

  it("says nothing at all when there is no split to report", () => {
    // The caller renders no line, rather than an empty one under the number.
    expect(tokenBreakdown({})).toBe("");
    expect(tokenBreakdown({ total: 5_000 })).toBe("");
  });

  it("keeps a reported zero, because zero output is a fact about a run", () => {
    // A turn that generated nothing is different from a provider that does
    // not break its counts out — and only `input`/`output` can say it.
    expect(tokenBreakdown({ input: 900, output: 0 })).toBe("↑ 900 · ↓ 0");
    // Cache is the exception: it is absent far more often than it is zero,
    // and a "cache 0" on every codex row would be noise.
    expect(tokenBreakdown({ input: 900, cacheRead: 0 })).toBe("↑ 900");
  });
});
