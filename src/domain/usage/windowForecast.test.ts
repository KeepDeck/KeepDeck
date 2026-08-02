import { describe, expect, it } from "vitest";
import {
  accountWindowKeys,
  currentSegment,
  decodeWindowReport,
  encodeWindowReport,
  pruneReports,
  shouldRecord,
  storedReportKey,
  windowReportKey,
  type WindowReport,
} from "./reportJournal";
import {
  accountWindowForecasts,
  cardCaptionParts,
  panelWindowCaption,
  windowForecast,
} from "./windowForecast";
import { NO_REPORTS } from "./reportJournal";
import { windowBurn } from "./windowBurn";
import type { AccountUsage, UsageWindow } from "./usage";

import { TEST_NOW, windowReport as report } from "./reportJournal.testSupport";

const NOW = TEST_NOW;
const MIN = 60_000;

/** A steady ramp: `pctPerMin` growth, newest report at `now`. */
const ramp = (
  pctPerMin: number,
  points: number,
  stepMin: number,
  lastPct: number,
  resetsAt: number | null = NOW + 155 * MIN,
): WindowReport[] =>
  Array.from({ length: points }, (_, index) => {
    const minutesAgo = (points - 1 - index) * stepMin;
    return report({
      reportedAt: NOW - minutesAgo * MIN,
      usedPct: lastPct - pctPerMin * minutesAgo,
      resetsAt,
    });
  });

const FIVE_H: UsageWindow = {
  usedPct: 62,
  resetsAt: NOW + 155 * MIN,
  windowMinutes: 300,
};

describe("reportJournal", () => {
  it("keys a window by agent, length and scope", () => {
    expect(windowReportKey("claude", { windowMinutes: 300 })).toBe(
      "claude\x00300\x00",
    );
    expect(
      windowReportKey("codex", { windowMinutes: null, scope: "quota" }),
    ).toBe("codex\x00?\x00quota");
  });

  it("records changes and heartbeats, drops chatter and replays", () => {
    const last = report();
    expect(shouldRecord(undefined, last)).toBe(true);
    expect(
      shouldRecord(last, report({ reportedAt: last.reportedAt + 2_000 })),
    ).toBe(false); // same pct, same reset, 2s later — chatter
    expect(
      shouldRecord(
        last,
        report({ reportedAt: last.reportedAt + 2_000, usedPct: 10.5 }),
      ),
    ).toBe(true);
    expect(
      shouldRecord(last, report({ reportedAt: last.reportedAt - 1 })),
    ).toBe(false); // replay never rewrites history
    expect(
      shouldRecord(last, report({ reportedAt: last.reportedAt + 6 * MIN })),
    ).toBe(true); // heartbeat keeps "pace ~0" a fresh fact
  });

  it("segments at a usage drop and at a forward reset jump", () => {
    const dropped = [
      report({ reportedAt: NOW - 60 * MIN, usedPct: 90 }),
      report({ reportedAt: NOW - 30 * MIN, usedPct: 3 }), // reset happened
      report({ reportedAt: NOW - 20 * MIN, usedPct: 5 }),
    ];
    expect(currentSegment(dropped)).toHaveLength(2);
    expect(currentSegment(dropped)[0].usedPct).toBe(3);

    const jumped = [
      report({ reportedAt: NOW - 60 * MIN, resetsAt: NOW - 40 * MIN }),
      report({ reportedAt: NOW - 30 * MIN, resetsAt: NOW + 260 * MIN, usedPct: 11 }),
    ];
    expect(currentSegment(jumped)).toHaveLength(1);
  });

  it("scales the retention horizon with the window length", () => {
    // Observed through pruneReports: a 5h window keeps ~7.5h (1.5 windows),
    // a plan window keeps a week.
    const at449 = report({ reportedAt: NOW - 449 * MIN });
    const at451 = report({ reportedAt: NOW - 451 * MIN });
    expect(pruneReports([at451, at449], NOW)).toEqual([at449]);
    const plan6d = report({ windowMinutes: null, reportedAt: NOW - 6 * 24 * 60 * MIN });
    const plan8d = report({ windowMinutes: null, reportedAt: NOW - 8 * 24 * 60 * MIN });
    expect(pruneReports([plan8d, plan6d], NOW)).toEqual([plan6d]);
  });

  it("floors short-window retention at 6h — through pruneReports", () => {
    const at5h = report({ windowMinutes: 60, reportedAt: NOW - 300 * MIN });
    const at7h = report({ windowMinutes: 60, reportedAt: NOW - 420 * MIN });
    expect(pruneReports([at7h, at5h], NOW)).toEqual([at5h]);
  });

  it("heals future-stamped records out — they would block every later write", () => {
    const future = report({ reportedAt: NOW + 24 * 60 * MIN });
    const fresh = report({ reportedAt: NOW - 10 * MIN });
    expect(pruneReports([fresh, future], NOW)).toEqual([fresh]);
  });

  it("mints distinct keys for duplicated tuples and round-trips the ordinal", () => {
    const a = { usedPct: 30, resetsAt: NOW + 100 * MIN, windowMinutes: null };
    const b = { usedPct: 88, resetsAt: NOW + 900 * MIN, windowMinutes: null };
    const keys = accountWindowKeys("codex", [a, b]);
    expect(keys.get(a)!.key).not.toBe(keys.get(b)!.key);
    expect(keys.get(a)!.ordinal).toBe(0);
    expect(keys.get(b)!.ordinal).toBe(1);
    // Ordinals are ALWAYS minted, so a tuple's duplicate count changing
    // between reports cannot re-key (and reset) the surviving window.
    const lone = { usedPct: 10, resetsAt: NOW + 100 * MIN, windowMinutes: 300 };
    expect(accountWindowKeys("claude", [lone]).get(lone)).toEqual({
      key: `${windowReportKey("claude", lone)}\x000`,
      ordinal: 0,
    });
    // A stored record regroups under the SAME key after a reload.
    const stored = report({ agent: "codex", windowMinutes: null, ordinal: 1 });
    expect(storedReportKey(stored)).toBe(keys.get(b)!.key);
    expect(decodeWindowReport(encodeWindowReport(stored))).toEqual(stored);
  });

  it("clamps stored usedPct into 0..100 like the cache codec", () => {
    const wild = report({ usedPct: 1e9 });
    expect(decodeWindowReport(encodeWindowReport(wild))!.usedPct).toBe(100);
    const negative = report({ usedPct: -5 });
    expect(decodeWindowReport(encodeWindowReport(negative))!.usedPct).toBe(0);
  });

  it("round-trips the codec and rejects junk", () => {
    const item = report({ scope: "quota" });
    expect(decodeWindowReport(encodeWindowReport(item))).toEqual(item);
    expect(decodeWindowReport("torn{")).toBeNull();
    expect(decodeWindowReport(JSON.stringify({ agent: "", usedPct: 1, reportedAt: 1 }))).toBeNull();
    expect(
      decodeWindowReport(JSON.stringify({ agent: "a", usedPct: 1, reportedAt: 0 })),
    ).toBeNull();
  });

  it("prune drops the aged and keeps the recent", () => {
    const old = report({ reportedAt: NOW - 100 * 60 * MIN });
    const fresh = report({ reportedAt: NOW - 10 * MIN });
    expect(pruneReports([old, fresh], NOW)).toEqual([fresh]);
  });
});

describe("windowForecast", () => {
  it("anchors the lookback to the newest report, not the ticking clock", () => {
    // A burst 44m ago inside a 45m lookback: one clock tick later the tick
    // itself must NOT change the verdict — only new reports may.
    const burst = [
      report({ reportedAt: NOW - 46 * MIN, usedPct: 10 }),
      report({ reportedAt: NOW - 44 * MIN, usedPct: 30 }),
      report({ reportedAt: NOW - 30 * MIN, usedPct: 30.2 }),
      report({ reportedAt: NOW - 4 * MIN, usedPct: 30.4 }),
    ];
    const before = windowForecast(burst, FIVE_H, NOW);
    const after = windowForecast(burst, FIVE_H, NOW + 2 * MIN);
    expect(after.kind).toBe(before.kind);
  });

  it("ignores reports older than the lookback behind the newest one", () => {
    // A 5h window's lookback is 45m behind the NEWEST report: an ancient
    // steep point must not drive today's pace.
    const tail = [
      report({ reportedAt: NOW - 50 * MIN, usedPct: 5 }),
      report({ reportedAt: NOW - 40 * MIN, usedPct: 62 }),
      report({ reportedAt: NOW - 20 * MIN, usedPct: 62 }),
      report({ reportedAt: NOW, usedPct: 62 }),
    ];
    // Inside the lookback the usage is flat → ok; including the -50m point
    // would have called a runaway pace.
    expect(windowForecast(tail, FIVE_H, NOW)).toEqual({ kind: "ok", outAt: null });
  });

  it("keeps a fresh-tail verdict through a silent stretch — push data does not age", () => {
    // claude stamps reports by transcript mtime; a 10-minute tool call is
    // silence, not idleness. A verdict computed from a fresh tail must
    // survive it (only the already-at-the-wall escalation needs freshness).
    const verdict = windowForecast(ramp(0.29, 5, 10, 62), FIVE_H, NOW + 10 * MIN);
    expect(verdict.kind).toBe("out");
  });

  it("never escalates to critical during silence — amber holds, red needs data", () => {
    // Pace says out in ~20m, but the stream has been quiet 20m: the
    // verdict stays (push data does not age) at WARN — a red countdown on
    // an idle window was the original false-alarm finding.
    const quiet = [
      report({ reportedAt: NOW - 40 * MIN, usedPct: 70 }),
      report({ reportedAt: NOW - 20 * MIN, usedPct: 80 }),
    ];
    const verdict = windowForecast(quiet, FIVE_H, NOW);
    expect(verdict).toMatchObject({ kind: "out", level: "warn" });
  });

  it("goes unknown when the report stream stops — no red alarm on an idle account", () => {
    // Steep pace, but the newest report is 20 minutes old: extrapolating a
    // dead stream painted 'runs out in ~0m' over an idle window.
    const idle = [
      report({ reportedAt: NOW - 40 * MIN, usedPct: 70 }),
      report({ reportedAt: NOW - 20 * MIN, usedPct: 90 }),
    ];
    expect(windowForecast(idle, FIVE_H, NOW).kind).toBe("unknown");
  });

  it("refuses to extrapolate a long window from a short burst", () => {
    // A week-long window with 10 minutes of reports: honest answer is
    // "don't know yet", not "runs out ~6d early".
    const week: UsageWindow = {
      usedPct: 30,
      resetsAt: NOW + 6 * 24 * 60 * MIN,
      windowMinutes: 10_080,
    };
    const burst = [
      report({ windowMinutes: 10_080, reportedAt: NOW - 10 * MIN, usedPct: 2, resetsAt: week.resetsAt }),
      report({ windowMinutes: 10_080, reportedAt: NOW, usedPct: 30, resetsAt: week.resetsAt }),
    ];
    expect(windowForecast(burst, week, NOW).kind).toBe("unknown");
  });

  it("is unknown without enough recent evidence", () => {
    expect(windowForecast([], FIVE_H, NOW).kind).toBe("unknown");
    expect(windowForecast([report()], FIVE_H, NOW).kind).toBe("unknown");
    // Two points 2 minutes apart — span too short to call a pace.
    expect(
      windowForecast(
        [
          report({ reportedAt: NOW - 2 * MIN, usedPct: 10 }),
          report({ reportedAt: NOW, usedPct: 11 }),
        ],
        FIVE_H,
        NOW,
      ).kind,
    ).toBe("unknown");
  });

  it("says ok when the pace survives to the reset (or is flat)", () => {
    // 0.1%/min: 38% left needs 380m, reset in 155m → survives.
    const slow = windowForecast(ramp(0.1, 5, 10, 62), FIVE_H, NOW);
    expect(slow.kind).toBe("ok");
    // Flat usage → ok with no projected exhaustion at all.
    const flat = windowForecast(ramp(0, 5, 10, 62), FIVE_H, NOW);
    expect(flat).toEqual({ kind: "ok", outAt: null });
  });

  it("calls the race for the pace when it beats the reset", () => {
    // 0.29%/min: 38% left ≈ 131m < 155m to reset → out, warn (>1h away).
    const verdict = windowForecast(ramp(0.29, 5, 10, 62), FIVE_H, NOW);
    expect(verdict.kind).toBe("out");
    if (verdict.kind === "out") {
      expect(verdict.level).toBe("warn");
      expect(verdict.beforeResetMs).toBeGreaterThan(20 * MIN);
      expect(Math.abs(verdict.outAt - (NOW + 131 * MIN))).toBeLessThan(2 * MIN);
    }
  });

  it("goes critical inside the last hour", () => {
    const verdict = windowForecast(ramp(1, 5, 10, 88), FIVE_H, NOW);
    // 12% left at 1%/min → out in 12m.
    expect(verdict).toMatchObject({ kind: "out", level: "critical" });
  });

  it("forecasts windows with no known reset, without a comparison", () => {
    const window: UsageWindow = { usedPct: 30, resetsAt: null, windowMinutes: null };
    const verdict = windowForecast(
      ramp(0.01, 5, 60, 30, null),
      window,
      NOW,
    );
    expect(verdict).toMatchObject({ kind: "out", beforeResetMs: null });
  });

  it("never computes a pace across a reset boundary", () => {
    const acrossReset = [
      report({ reportedAt: NOW - 40 * MIN, usedPct: 95 }),
      report({ reportedAt: NOW - 30 * MIN, usedPct: 2 }),
      report({ reportedAt: NOW - 15 * MIN, usedPct: 4 }),
      report({ reportedAt: NOW, usedPct: 6 }),
    ];
    const verdict = windowForecast(acrossReset, FIVE_H, NOW);
    // Only the post-reset segment counts: 2→6% over 30m — slow, survives.
    expect(verdict.kind).toBe("ok");
  });

  it("leaves the near-tie to the reset — no flicker at the margin", () => {
    // Out lands ~1m short of the reset: inside the margin → ok.
    const verdict = windowForecast(ramp(0.2465, 5, 10, 62), FIVE_H, NOW);
    expect(verdict.kind).toBe("ok");
  });

  it("hides behind expiry", () => {
    const expired: UsageWindow = { ...FIVE_H, resetsAt: NOW - 1 };
    expect(windowForecast(ramp(0.5, 5, 10, 62), expired, NOW).kind).toBe(
      "unknown",
    );
  });
});

describe("captions", () => {
  const out = windowForecast(ramp(0.29, 5, 10, 62), FIVE_H, NOW);
  const crit = windowForecast(ramp(1, 5, 10, 88), FIVE_H, NOW);
  const ok = windowForecast(ramp(0.1, 5, 10, 62), FIVE_H, NOW);

  it("phrases the card clause relatively, countdown when imminent", () => {
    const warnParts = cardCaptionParts(FIVE_H, out, NOW);
    expect(warnParts[1].text).toMatch(/^on pace to run out ~.* early$/);
    const critParts = cardCaptionParts(FIVE_H, crit, NOW);
    expect(critParts[0].text).toMatch(/^on pace to run out in ~/);
    expect(cardCaptionParts(FIVE_H, ok, NOW)).toHaveLength(1); // reset only
  });

  it("orders the card caption: reset anchors, critical leads", () => {
    const warnParts = cardCaptionParts(FIVE_H, out, NOW).map((p) => p.level);
    expect(warnParts).toEqual([null, "warn"]);
    const critParts = cardCaptionParts(FIVE_H, crit, NOW).map((p) => p.level);
    expect(critParts).toEqual(["critical", null]);
  });

  it("swaps the popover line to the next relevant event", () => {
    expect(panelWindowCaption(FIVE_H, ok, NOW)).toEqual({
      text: "resets in 2h 35m",
      level: null,
    });
    const swapped = panelWindowCaption(FIVE_H, out, NOW);
    expect(swapped.text).toMatch(/^runs out in ~/);
    expect(swapped.level).toBe("warn");
  });
});

describe("windowBurn", () => {
  const out = windowForecast(ramp(0.29, 5, 10, 62), FIVE_H, NOW);

  it("fills the data axis and puts the out dot at the top-right corner", () => {
    const geometry = windowBurn(ramp(0.29, 5, 10, 62), FIVE_H, out, NOW)!;
    // Data axis: first report at the left edge, projection end at the right.
    expect(geometry.observed[0].x).toBe(0);
    expect(geometry.out).toEqual({ x: 1, y: 1, level: "warn" });
    expect(geometry.yMaxPct).toBe(100); // the projection reaches the ceiling
    const [from, to] = geometry.projected!;
    expect(from.y).toBeCloseTo(0.62, 2);
    expect(to.y).toBeCloseTo(1, 2);
    expect(geometry.resetAtEdge).toBe(false); // the out beats the reset
  });

  it("caps a surviving pace at the reset: exits the right edge below the ceiling", () => {
    const ok = windowForecast(ramp(0.1, 5, 10, 62), FIVE_H, NOW);
    const geometry = windowBurn(ramp(0.1, 5, 10, 62), FIVE_H, ok, NOW)!;
    expect(geometry.resetAtEdge).toBe(true);
    expect(geometry.out).toBeNull();
    expect(geometry.projected![1].x).toBe(1);
    expect(geometry.projected![1].y).toBeLessThan(1);
  });

  it("charts a plan window on the same data axis — no reset anchor needed", () => {
    const plan: UsageWindow = { usedPct: 30, resetsAt: null, windowMinutes: null };
    const verdict = windowForecast(ramp(0.01, 5, 60, 30, null), plan, NOW);
    const geometry = windowBurn(ramp(0.01, 5, 60, 30, null), plan, verdict, NOW)!;
    expect(geometry).not.toBeNull();
    expect(geometry.out).not.toBeNull(); // no reset will ever save it
    const expired: UsageWindow = { ...FIVE_H, resetsAt: NOW - 1 };
    expect(windowBurn(ramp(0.29, 5, 10, 62), expired, out, NOW)).toBeNull();
  });

  it("draws observed-only up to now when the forecast is unknown", () => {
    const geometry = windowBurn(
      ramp(0.29, 2, 1, 62),
      FIVE_H,
      { kind: "unknown" },
      NOW,
    )!;
    expect(geometry.projected).toBeNull();
    expect(geometry.out).toBeNull();
    expect(geometry.observed[0].x).toBe(0);
    expect(geometry.observed[geometry.observed.length - 1].x).toBe(1);
  });

  it("scales y to the data with headroom, never an empty frame", () => {
    const flat = windowBurn(
      ramp(0, 5, 10, 1),
      { usedPct: 1, resetsAt: NOW + 155 * MIN, windowMinutes: 300 },
      { kind: "ok", outAt: null },
      NOW,
    )!;
    expect(flat.yMaxPct).toBe(10); // floored — a 1% line still reads
    expect(flat.observed[0].y).toBeCloseTo(0.1, 2);
  });
});

describe("accountWindowForecasts", () => {
  const reported = (windows: UsageWindow[]): AccountUsage => ({
    kind: "reported",
    windows,
    reportedAt: NOW - MIN,
    sourcePaneId: "pane-1",
  });

  it("is empty for an account that never reported", () => {
    expect(
      accountWindowForecasts(
        "opencode",
        { kind: "unavailable", reason: "api-key", reportedAt: NOW },
        new Map(),
        NOW,
      ).size,
    ).toBe(0);
  });

  it("pairs every window with its own series by the writer's key rule", () => {
    // codex's duration-less twins: same tuple, distinct ordinals — the
    // second must not read the first one's history.
    const windows: UsageWindow[] = [
      { usedPct: 88, resetsAt: NOW + 155 * MIN, windowMinutes: null },
      { usedPct: 12, resetsAt: NOW + 300 * MIN, windowMinutes: null },
    ];
    const keys = accountWindowKeys("codex", windows);
    const hotKey = keys.get(windows[0])!.key;
    const series = ramp(1, 5, 10, 88).map((entry) => ({
      ...entry,
      agent: "codex",
      windowMinutes: null,
    }));
    const rows = accountWindowForecasts(
      "codex",
      reported(windows),
      new Map([[hotKey, series]]),
      NOW,
    );
    expect(rows.size).toBe(2);
    const hot = rows.get(windows[0])!;
    expect(hot.key).toBe(hotKey);
    expect(hot.reports).toBe(series);
    expect(hot.forecast.kind).toBe("out");
    const quiet = rows.get(windows[1])!;
    expect(quiet.key).toBe(keys.get(windows[1])!.key);
    expect(quiet.key).not.toBe(hotKey);
    expect(quiet.reports).toBe(NO_REPORTS); // the shared frozen fallback
    expect(quiet.forecast).toEqual({ kind: "unknown" });
  });
});
