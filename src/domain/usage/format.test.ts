import { describe, expect, it } from "vitest";
import {
  chipWindows,
  contextLevel,
  formatAge,
  formatBucket,
  formatCountdown,
  formatPct,
  formatTokens,
  formatUsd,
  limitLevel,
  panelWindows,
  tokenBreakdown,
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
    expect(windowResetCaption(expired, NOW, "long")).toBe(
      "reset passed · % is from the previous window",
    );
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
