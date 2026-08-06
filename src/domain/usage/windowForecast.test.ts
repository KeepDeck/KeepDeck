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

  it("leads the card clause with WHEN, keeping the margin as the qualifier", () => {
    // The old phrasing gave only "~38h 25m early", which had to be
    // subtracted from a reset countdown printed elsewhere in the same line,
    // in a different unit, before it answered anything.
    const warnParts = cardCaptionParts(FIVE_H, out, NOW);
    // "on pace to", never a bare "hits": the module's contract is that a
    // forecast always names itself an extrapolation, and dropping the hedge
    // here attached the STRONGER claim to the WEAKER verdict.
    expect(warnParts[1].text).toMatch(
      /^on pace to hit 100% ~.+ · ~.+ before reset$/,
    );
    // Imminent keeps the countdown: minutes from now need no clock face.
    const critParts = cardCaptionParts(FIVE_H, crit, NOW);
    expect(critParts[0].text).toMatch(/^on pace to run out in ~/);
  });

  it("gives a surviving window something to say about how it ends", () => {
    // The most common state used to be the least legible: a curve climbing
    // across a frame, and a caption that named only the reset. The forecast
    // owns the landing now, so no chart has to exist first.
    const parts = cardCaptionParts(FIVE_H, ok, NOW);
    expect(parts).toHaveLength(2);
    expect(parts[1].text).toMatch(/^on pace to last the window · ends near \d+%$/);
    expect(parts[1].level).toBeNull();
    // The percentage follows the app's rule — CEIL, like every other one on
    // the card. A local round made the chart's own tooltip and the sentence
    // under it disagree about the same point.
    expect(parts[1].text).toContain(formatPct((ok as { endPct: number }).endPct, "used"));
    // A pace of ~zero has nothing to extrapolate and claims nothing.
    const flat = windowForecast(ramp(0, 5, 10, 20), FIVE_H, NOW);
    expect(cardCaptionParts(FIVE_H, flat, NOW)).toHaveLength(1);
  });

  it("speaks up for a pace that reaches the ceiling inside the verdict margin", () => {
    // `ok` means "too close to call a race", NOT "will be fine": when the
    // run-out lands within the margin of the reset the projection still
    // ends AT 100. That band drew a dashed line into the top-right corner
    // with no clause, no edge label and no dot — up to 3h21m wide on a
    // week window.
    const resetsAt = NOW + 180 * MIN;
    const window: UsageWindow = { usedPct: 62, resetsAt, windowMinutes: 300 };
    // A pace that exhausts 177 minutes out, three minutes before the reset:
    // inside the 6-minute margin a 5h window allows, so the verdict is "ok".
    const reports = ramp((100 - 62) / 177, 5, 10, 62, resetsAt);
    const forecast = windowForecast(reports, window, NOW);
    expect(forecast.kind).toBe("ok");
    const parts = cardCaptionParts(window, forecast, NOW);
    expect(parts[1].text).toMatch(/^on pace to reach 100% by the reset$/);
    expect(parts[1].level).toBe("warn");
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
    expect(swapped.text).toMatch(/^runs out in ~/);
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
