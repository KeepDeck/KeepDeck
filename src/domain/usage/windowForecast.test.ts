import { describe, expect, it } from "vitest";
import { formatMoment, formatPct } from "./format";
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
  burnEdgeLabel,
  cardCaptionParts,
  panelWindowCaption,
  windowForecast,
} from "./windowForecast";
import { NO_REPORTS } from "./reportJournal";
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

  it("segments where the RESET moved, not merely where usage fell", () => {
    // A window instance IS its reset instant. A real turnover moves both.
    const reset = [
      report({ reportedAt: NOW - 60 * MIN, usedPct: 90, resetsAt: NOW - 40 * MIN }),
      report({ reportedAt: NOW - 30 * MIN, usedPct: 3, resetsAt: NOW + 260 * MIN }),
      report({ reportedAt: NOW - 20 * MIN, usedPct: 5, resetsAt: NOW + 260 * MIN }),
    ];
    expect(currentSegment(reset)).toHaveLength(2);
    expect(currentSegment(reset)[0].usedPct).toBe(3);

    // A forward reset jump alone is still a boundary — the counter need not
    // have fallen for the window to have turned over.
    const jumped = [
      report({ reportedAt: NOW - 60 * MIN, resetsAt: NOW - 40 * MIN }),
      report({ reportedAt: NOW - 30 * MIN, resetsAt: NOW + 260 * MIN, usedPct: 11 }),
    ];
    expect(currentSegment(jumped)).toHaveLength(1);
  });

  it("keeps a lone bad reading from passing as a window turnover", () => {
    // THE inversion, from a real journal: the reporters send whole percents,
    // and one spurious low reading landed between two honest ones with the
    // reset instant UNCHANGED. Restarting the segment there made the climb
    // back to the true level read as burn — 1.42 %/min against an actual
    // 0.16 — and a window with 3h40m of headroom was announced as running
    // out in forty minutes.
    const spike = [
      report({ reportedAt: NOW - 44 * MIN, usedPct: 13 }),
      report({ reportedAt: NOW - 20 * MIN, usedPct: 17 }),
      report({ reportedAt: NOW - 6 * MIN, usedPct: 19 }),
      report({ reportedAt: NOW - 5 * MIN, usedPct: 8 }), // the outlier
      report({ reportedAt: NOW, usedPct: 19 }),
    ];
    expect(currentSegment(spike)).toHaveLength(5);

    // The whole point: the verdict flips with it. Reset is 155m out, and
    // the honest pace over this tail lands nowhere near the ceiling.
    const forecast = windowForecast(spike, FIVE_H, NOW);
    expect(forecast.kind).toBe("ok");
  });

  it("still segments on a drop when the window has no known reset", () => {
    // Plan windows report no reset instant, so the fall is the only
    // evidence a turnover happened and has to keep counting as one.
    const dropped = [
      report({ reportedAt: NOW - 60 * MIN, usedPct: 90, resetsAt: null }),
      report({ reportedAt: NOW - 30 * MIN, usedPct: 3, resetsAt: null }),
      report({ reportedAt: NOW - 20 * MIN, usedPct: 5, resetsAt: null }),
    ];
    expect(currentSegment(dropped)).toHaveLength(2);
    expect(currentSegment(dropped)[0].usedPct).toBe(3);
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
    expect(windowForecast(tail, FIVE_H, NOW)).toEqual({ kind: "ok", outAt: null, endPct: null });
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
    expect(flat).toEqual({ kind: "ok", outAt: null, endPct: null });
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

  it("names the thing you run into, and when, in the reset's own unit", () => {
    // The clause used to lead with a clock face and trail a MARGIN
    // ("~38h 25m before reset"), which is a derived quantity: the reset
    // countdown is already on this line, and nobody subtracts two clocks in
    // their head. A countdown to the run-out answers the question directly
    // and is comparable to its neighbour at a glance.
    const warnParts = cardCaptionParts(FIVE_H, out, NOW);
    expect(warnParts[1].text).toMatch(/^Will hit the limit in ~.+$/);
    expect(warnParts[1].text).not.toContain("before reset");
    // "the limit", not "100%": a percentage is a number, not an outcome.
    expect(warnParts[1].text).not.toContain("100%");
    // Imminent takes the same shape — only the level and the ordering move.
    const critParts = cardCaptionParts(FIVE_H, crit, NOW);
    expect(critParts[0].text).toMatch(/^Will hit the limit in ~/);
    expect(critParts[0].level).toBe("critical");
  });

  it("tells a surviving window how much it has LEFT, not where its curve stops", () => {
    // "ends near 33%" named the number the line lands on. The reader is not
    // holding a line; they are holding a budget, so the useful quantity is
    // the headroom.
    const parts = cardCaptionParts(FIVE_H, ok, NOW);
    expect(parts).toHaveLength(2);
    expect(parts[1].text).toMatch(/^Won't hit the limit · ~\d+% left$/);
    expect(parts[1].level).toBeNull();
    // Percentages follow the app's rule — CEIL, like every other one on the
    // card — and this one is the complement of the landing level.
    expect(parts[1].text).toContain(
      formatPct(100 - (ok as { endPct: number }).endPct, "used"),
    );
  });

  it("separates an idle window from one it cannot read yet", () => {
    // Both used to be the same silence, so the state most windows are in for
    // their first minutes was indistinguishable from an account nobody is
    // using — and neither explained the burn plot's empty right half.
    const flat = windowForecast(ramp(0, 5, 10, 20), FIVE_H, NOW);
    expect(cardCaptionParts(FIVE_H, flat, NOW)[1].text).toBe(
      "Not spending right now",
    );
    const blind = windowForecast(NO_REPORTS, FIVE_H, NOW);
    expect(blind.kind).toBe("unknown");
    expect(cardCaptionParts(FIVE_H, blind, NOW)[1].text).toBe(
      "Not enough data yet",
    );
  });

  it("does not call landing exactly on the limit a warning", () => {
    // THE mis-signal. When the run-out lands inside the verdict margin of
    // the reset, the pace reaches ~100% right as the window renews — the
    // whole allowance used and nothing wasted, which is the BEST outcome.
    // It was painted amber and phrased "on pace to reach 100% by the reset",
    // one word away from the actual alarm ("on pace to hit 100%"), so the
    // reader could not tell the best case from the worst.
    const resetsAt = NOW + 180 * MIN;
    const window: UsageWindow = { usedPct: 62, resetsAt, windowMinutes: 300 };
    // Exhausts 177 minutes out, three before the reset: inside the 6-minute
    // margin a 5h window allows, so the verdict is "ok".
    const reports = ramp((100 - 62) / 177, 5, 10, 62, resetsAt);
    const forecast = windowForecast(reports, window, NOW);
    expect(forecast.kind).toBe("ok");
    const parts = cardCaptionParts(window, forecast, NOW);
    expect(parts[1].text).toBe("Won't hit the limit · ~0% left");
    expect(parts[1].level).toBeNull();
  });

  it("names the plot's right edge as a moment, and always names it", () => {
    // The edge already IS "when do I hit 100%" — the out dot sits on it —
    // and it no longer needs a geometry built first to say so.
    // Compared against the formatter rather than a shape: the fixture's
    // run-out is 2h35m out, which crosses LOCAL midnight in some zones and
    // not others, so `/^\d{2}:\d{2}$/` pinned the runner's timezone instead
    // of the contract. What matters is that the edge names that instant.
    const edge = burnEdgeLabel(FIVE_H, out, NOW);
    expect(edge.text).toBe(
      formatMoment((out as { outAt: number }).outAt, NOW),
    );
    expect(edge.level).toBe("warn");
    expect(edge.atReset).toBe(false);

    // A surviving pace ends at the reset, and says so.
    const resetEdge = burnEdgeLabel(FIVE_H, ok, NOW);
    expect(resetEdge.text).toBe(`reset ${formatMoment(FIVE_H.resetsAt!, NOW)}`);
    expect(resetEdge.atReset).toBe(true);

    // No projection at all: the axis ends at now. Saying so is what turns
    // an empty right half into "nothing has been reported since" — the
    // state a provider that stopped reporting renders in.
    expect(burnEdgeLabel(FIVE_H, { kind: "unknown" }, NOW)).toEqual({
      text: "now",
      level: null,
      atReset: false,
    });
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
    expect(swapped.text).toMatch(/^hits the limit in ~/);
    expect(swapped.level).toBe("warn");
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
