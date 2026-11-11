import { describe, expect, it } from "vitest";
import { usageEvent } from "../history/event.testSupport";
import type { WindowReport } from "../reportJournal";
import { inZone } from "../time.testSupport";
import { oldestWeekBack, weekRhythm, weekSpans, windowPeaks } from "./weekly";

const at = (iso: string) => new Date(iso).getTime();
const NOW = at("2026-11-11T21:00:00+02:00"); // a Wednesday

describe("calendar weeks", () => {
  it("runs this week from its Monday to now, against last week up to the same point", () => {
    inZone("Asia/Nicosia", () => {
      const week = weekSpans(NOW, 0);
      expect(week.current).toEqual({ from: at("2026-11-09T00:00:00+02:00"), to: NOW + 1 });
      expect(week.prior).toEqual({ from: at("2026-11-02T00:00:00+02:00"), to: at("2026-11-04T21:00:00+02:00") + 1 });
      expect(week.complete).toBe(false);
    });
  });

  it("gives a past week whole, against the whole week before it", () => {
    inZone("Asia/Nicosia", () => {
      const week = weekSpans(NOW, 1);
      expect(week.current).toEqual({ from: at("2026-11-02T00:00:00+02:00"), to: at("2026-11-09T00:00:00+02:00") });
      expect(week.prior).toEqual({ from: at("2026-10-26T00:00:00+02:00"), to: at("2026-11-02T00:00:00+02:00") });
      expect(week.complete).toBe(true);
    });
  });

  it("counts whole weeks across a clock change", () => {
    inZone("Europe/Berlin", () => {
      // The week of Oct 26 starts the morning after the autumn change.
      const week = weekSpans(at("2026-10-28T12:00:00+01:00"), 1);
      expect(week.current).toEqual({ from: at("2026-10-19T00:00:00+02:00"), to: at("2026-10-26T00:00:00+01:00") });
    });
  });

  it("pages back as far as the oldest row's week, and nowhere for an empty ledger", () => {
    inZone("Asia/Nicosia", () => {
      expect(oldestWeekBack([usageEvent({ occurredAt: at("2026-10-27T10:00:00+02:00") })], NOW)).toBe(2);
      expect(oldestWeekBack([usageEvent({ occurredAt: at("2026-11-10T10:00:00+02:00") })], NOW)).toBe(0);
      expect(oldestWeekBack([], NOW)).toBe(0);
    });
  });
});

describe("a week's rhythm", () => {
  it("lays the priced money out by local weekday and hour, unpriced usage left out", () => {
    inZone("Asia/Nicosia", () => {
      const rhythm = weekRhythm(
        [
          usageEvent({ occurredAt: at("2026-11-09T01:30:00+02:00"), costUsd: 2 }), // Monday 01h
          usageEvent({ occurredAt: at("2026-11-11T14:00:00+02:00"), costUsd: 3 }), // Wednesday 14h
          usageEvent({ occurredAt: at("2026-11-11T14:30:00+02:00") }),
          usageEvent({ occurredAt: at("2026-11-08T23:00:00+02:00"), costUsd: 9 }), // last week
        ],
        weekSpans(NOW, 0).current,
      );
      expect(rhythm.byWeekday).toEqual([2, 0, 3, 0, 0, 0, 0]);
      expect(rhythm.byHour[1]).toBe(2);
      expect(rhythm.byHour[14]).toBe(3);
      expect(rhythm.byHour.reduce((sum, v) => sum + v, 0)).toBe(5);
    });
  });
});

describe("limit peaks", () => {
  const report = (usedPct: number, reportedAt: number): WindowReport => ({
    agent: "claude", windowMinutes: 10_080, usedPct, reportedAt, resetsAt: null,
  });

  it("keeps each window's highest reading inside the span, the fullest first", () => {
    const span = { from: 100, to: 200 };
    const peaks = windowPeaks(
      new Map([
        ["week", [report(40, 120), report(97, 190), report(99, 250)]],
        ["5h", [report(60, 150)]],
        ["gone", [report(80, 50)]],
      ]),
      span,
    );
    expect(peaks.map((peak) => [peak.key, peak.report.usedPct])).toEqual([["week", 97], ["5h", 60]]);
  });
});
