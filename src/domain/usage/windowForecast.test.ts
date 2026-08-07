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
  type WindowForecast,
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
    expect(forecast.kind).toBe("lasts");
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
    // Inside the lookback the usage is flat → idle, EXACTLY: the fit is
    // taken from the newest report, so a flat tail has a covariance of zero
    // rather than a few-ulp residue that would read as a pace.
    expect(windowForecast(tail, FIVE_H, NOW)).toEqual({ kind: "idle" });
  });

  it("weighs recent readings heavier, so a hard turn still raises the alarm", () => {
    // The fit exists to survive ±1 quantisation noise, but an UNWEIGHTED one
    // is order-blind — and pace is not. These two tails are opposites: nine
    // flat readings then a jump (someone just started; the wall is minutes
    // away) versus a jump then nine flat (someone spent and went to read;
    // the wall is never). A plain least-squares slope returns the SAME
    // answer for both, which pushed the run-out past the critical hour and
    // silenced the exhaustion alarm on the dangerous one.
    const tail = (pcts: number[]) =>
      pcts.map((usedPct, index) =>
        report({
          reportedAt: NOW - (pcts.length - 1 - index) * 5 * MIN,
          usedPct,
          resetsAt: NOW + 300 * MIN,
        }),
      );
    const window: UsageWindow = {
      usedPct: 70,
      resetsAt: NOW + 300 * MIN,
      windowMinutes: 300,
    };
    const turn = windowForecast(tail([40, 40, 40, 40, 40, 40, 40, 40, 40, 70]), window, NOW);
    const idled = windowForecast(tail([40, 70, 70, 70, 70, 70, 70, 70, 70, 70]), window, NOW);
    expect(turn).toMatchObject({ kind: "out", level: "critical" });
    expect(idled).toMatchObject({ kind: "out", level: "warn" });
    // Not merely different levels — the run-outs are far apart, which is the
    // property an unweighted fit cannot have.
    if (turn.kind === "out" && idled.kind === "out") {
      expect(idled.outAt - turn.outAt).toBeGreaterThan(90 * MIN);
    }
  });

  it("still averages quantisation noise away on a steady climb", () => {
    // The other half of the same trade: whole-percent reporting means every
    // reading carries up to a point of noise, and the endpoint line put all
    // of it on the slope. A true 0.16 %/min climb read as 0.114 that way.
    const points = Array.from({ length: 21 }, (_, index) => {
      const minutesAgo = (20 - index) * 2.2;
      const exact = 13 + 0.16 * (20 - minutesAgo / 2.2) * 2.2;
      const noise = index === 0 ? 1 : index === 20 ? -1 : 0;
      return report({
        reportedAt: NOW - minutesAgo * MIN,
        usedPct: Math.round(exact) + noise,
        resetsAt: NOW + 600 * MIN,
      });
    });
    const window: UsageWindow = {
      usedPct: points[points.length - 1].usedPct,
      resetsAt: NOW + 600 * MIN,
      windowMinutes: 300,
    };
    const verdict = windowForecast(points, window, NOW);
    expect(verdict.kind).toBe("out");
    if (verdict.kind === "out") {
      // Recovered pace, read back off the projection. The endpoint line
      // would have said 0.114 here — a 29% understatement that puts the
      // run-out three hours further away than it is.
      const paceMin = (100 - window.usedPct) / ((verdict.outAt - NOW) / MIN);
      expect(paceMin).toBeGreaterThan(0.135);
      expect(paceMin).toBeLessThan(0.175);
    }
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

  it("says the window lasts when the pace survives to the reset", () => {
    // 0.1%/min: 38% left needs 380m, reset in 155m → survives.
    const slow = windowForecast(ramp(0.1, 5, 10, 62), FIVE_H, NOW);
    expect(slow.kind).toBe("lasts");
    // Flat usage → a real answer, and its own kind: nothing is being spent.
    const flat = windowForecast(ramp(0, 5, 10, 62), FIVE_H, NOW);
    expect(flat).toEqual({ kind: "idle" });
  });

  it("refuses to project from a journal that contradicts itself", () => {
    // A FALLING counter is not "idle" — it is impossible, so this tail
    // straddles something segmentation could not see (a provider that reset
    // but lagged its `resetsAt`). Calling it "not spending" stated a
    // confident falsehood over a window that may be climbing hard, for a
    // whole lookback horizon.
    const falling = [
      report({ reportedAt: NOW - 40 * MIN, usedPct: 88 }),
      report({ reportedAt: NOW - 30 * MIN, usedPct: 90 }),
      report({ reportedAt: NOW - 20 * MIN, usedPct: 1 }),
      report({ reportedAt: NOW - 10 * MIN, usedPct: 3 }),
      report({ reportedAt: NOW, usedPct: 4 }),
    ];
    expect(windowForecast(falling, FIVE_H, NOW)).toEqual({ kind: "unknown" });
    expect(cardCaptionParts(FIVE_H, { kind: "unknown" }, NOW)[1].text).toBe(
      "Not enough data yet",
    );
  });

  it("calls the race for the pace when it beats the reset", () => {
    // 0.29%/min: 38% left ≈ 131m < 155m to reset → out, warn (>1h away).
    const verdict = windowForecast(ramp(0.29, 5, 10, 62), FIVE_H, NOW);
    expect(verdict.kind).toBe("out");
    if (verdict.kind === "out") {
      expect(verdict.level).toBe("warn");
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
    expect(verdict).toMatchObject({ kind: "out" });
  });

  it("never computes a pace across a reset boundary", () => {
    // The reset MOVES — that is what makes this a boundary, and the fixture
    // has to say so. It used to leave `resetsAt` untouched on all four rows
    // and passed anyway, because the un-segmented slope happened to come out
    // negative: the test named segmentation and proved arithmetic.
    const before = NOW + 20 * MIN;
    const after = NOW + 320 * MIN;
    const window: UsageWindow = { usedPct: 6, resetsAt: after, windowMinutes: 300 };
    const acrossReset = [
      report({ reportedAt: NOW - 40 * MIN, usedPct: 95, resetsAt: before }),
      report({ reportedAt: NOW - 30 * MIN, usedPct: 2, resetsAt: after }),
      report({ reportedAt: NOW - 15 * MIN, usedPct: 4, resetsAt: after }),
      report({ reportedAt: NOW, usedPct: 6, resetsAt: after }),
    ];
    // Only the post-reset segment counts: 2→6% over 30m — slow, survives.
    // Across the boundary the 95 would drag the pace negative, so a broken
    // segmentation reads as `unknown` rather than as this.
    expect(windowForecast(acrossReset, window, NOW)).toMatchObject({
      kind: "lasts",
    });
  });

  it("states the near-tie to the reset, but without a colour", () => {
    // Out lands ~1m short of the reset. The limit IS reached — saying
    // otherwise was the falsehood this replaced — but inside the margin the
    // projection cannot call a race, and a verdict that flickers at the
    // boundary is worse than none. So: `out` with no level.
    const verdict = windowForecast(ramp(0.2465, 5, 10, 62), FIVE_H, NOW);
    expect(verdict).toMatchObject({ kind: "out", level: null });
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

  it("says the wall is here when there is nothing left to count down to", () => {
    // The one phrasing no fixture reached: every "critical" tail in the
    // suite still had minutes on the clock, so `formatCountdown` never
    // returned null and both spellings shipped unexercised.
    const reached: WindowForecast = { kind: "out", outAt: NOW, level: "critical" };
    const parts = cardCaptionParts(FIVE_H, reached, NOW);
    // Critical leads the line, ahead of the reset anchor.
    expect(parts[0]).toEqual({ text: "Limit reached", level: "critical" });
    // The popover joins it into its own sentence — same fact, same phrase,
    // lower case because it continues rather than starts.
    expect(panelWindowCaption(FIVE_H, reached, NOW)).toEqual({
      text: "limit reached",
      level: "critical",
    });
  });

  it("tells a surviving window how much it has LEFT, not where its curve stops", () => {
    // "ends near 33%" named the number the line lands on. The reader is not
    // holding a line; they are holding a budget, so the useful quantity is
    // the headroom.
    const parts = cardCaptionParts(FIVE_H, ok, NOW);
    expect(parts).toHaveLength(2);
    expect(parts[1].text).toMatch(/^Won't hit the limit · ~\d+% left$/);
    expect(parts[1].level).toBeNull();
    // Through `formatPct`'s own "left" mode. Ceiling the complement by hand
    // rounds the wrong way: that mode ceils the USED side on purpose, so
    // `100 - ceil(endPct)` understates headroom where `ceil(100 - endPct)`
    // overstates it, and the two disagree by a point at every non-integer
    // landing.
    expect(parts[1].text).toContain(
      formatPct((ok as { endPct: number }).endPct, "left"),
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
    // margin a 5h window allows.
    const reports = ramp((100 - 62) / 177, 5, 10, 62, resetsAt);
    const forecast = windowForecast(reports, window, NOW);
    // It reaches the limit — `out`, and the sentence says so. What the
    // margin buys is the absence of a colour, not the inversion of the fact.
    expect(forecast).toMatchObject({ kind: "out", level: null });
    const parts = cardCaptionParts(window, forecast, NOW);
    expect(parts[1].text).toMatch(/^Will hit the limit in ~/);
    expect(parts[1].level).toBeNull();
    // And the plot's edge names the same instant, so the two cannot
    // disagree — which they did: "Won't hit the limit" sat under a dashed
    // line ending at 100 with its edge labelled the run-out clock time.
    expect(burnEdgeLabel(window, forecast, NOW).atReset).toBe(false);
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
