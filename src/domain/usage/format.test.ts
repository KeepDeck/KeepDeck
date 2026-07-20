import { describe, expect, it } from "vitest";
import {
  chipWindows,
  contextLevel,
  formatAge,
  formatCountdown,
  formatPct,
  formatTokens,
  limitLevel,
  panelWindows,
  usageStale,
  windowLabel,
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

describe("windowResetCaption", () => {
  const NOW = 1_000_000_000_000;
  it("covers all four window kinds", () => {
    expect(
      windowResetCaption({ usedPct: 1, resetsAt: NOW - 1, windowMinutes: 300 }, NOW),
    ).toBe("reset passed · awaiting report");
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

  it("is 0 for non-finite or negative input", () => {
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
  });
});
