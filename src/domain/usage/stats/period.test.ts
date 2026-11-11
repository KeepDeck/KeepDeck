import { describe, expect, it } from "vitest";
import { inZone } from "../time.testSupport";
import { inSpan, statsSpans, type Span, type StatsPeriod } from "./period";

/** The prior span of a period that has one. */
function priorOf(period: StatsPeriod, now: number): Span {
  const { prior } = statsSpans(period, now);
  if (prior === null) throw new Error(`${period} has no prior span`);
  return prior;
}

const at = (iso: string) => new Date(iso).getTime();

describe("the Statistics period", () => {
  it("opens N calendar days back at a local midnight and runs to now", () => {
    inZone("Asia/Nicosia", () => {
      const now = at("2026-11-10T23:45:00+02:00");
      const { current } = statsSpans(7, now);
      expect(current.from).toBe(at("2026-11-04T00:00:00+02:00"));
      expect(inSpan(now, current)).toBe(true);
      expect(inSpan(current.from - 1, current)).toBe(false);
    });
  });

  it("is today alone for one day", () => {
    inZone("Asia/Nicosia", () => {
      const now = at("2026-11-10T09:00:00+02:00");
      const { current, prior } = statsSpans(1, now);
      expect(current.from).toBe(at("2026-11-10T00:00:00+02:00"));
      // Yesterday up to the same point: 00:00–09:00.
      expect(prior).toEqual({ from: at("2026-11-09T00:00:00+02:00"), to: at("2026-11-09T09:00:00+02:00") + 1 });
    });
  });

  it("compares with the days just before, cut at the same point of the day", () => {
    inZone("Asia/Nicosia", () => {
      const now = at("2026-11-10T23:45:00+02:00");
      const { current } = statsSpans(7, now);
      const prior = priorOf(7, now);
      expect(prior.from).toBe(at("2026-10-28T00:00:00+02:00"));
      expect(prior.to).toBe(at("2026-11-03T23:45:00+02:00") + 1);
      // The prior span ends before the current one opens, and leaves out the
      // rest of its own last day.
      expect(prior.from).toBeLessThan(current.from);
      expect(inSpan(at("2026-11-03T23:50:00+02:00"), prior)).toBe(false);
      expect(inSpan(at("2026-11-04T00:00:00+02:00"), prior)).toBe(false);
    });
  });

  it("counts calendar days across a clock change, never 24-hour steps", () => {
    inZone("Europe/Berlin", () => {
      // The week holds the autumn change (Oct 25, a 25-hour day).
      const now = at("2026-10-28T12:00:00+01:00");
      const { current } = statsSpans(7, now);
      const prior = priorOf(7, now);
      expect(current.from).toBe(at("2026-10-22T00:00:00+02:00"));
      expect(prior.from).toBe(at("2026-10-15T00:00:00+02:00"));
      // Twelve hours into the day on both sides.
      expect(prior.to).toBe(at("2026-10-21T12:00:00+02:00") + 1);
    });
  });

  it("measures the point of the day as time since its start, so a skipped hour needs no case", () => {
    inZone("Europe/Berlin", () => {
      // Apr 5 03:30 compared with Mar 29, where 02:00–03:00 did not exist:
      // 3.5 hours into the day on both sides.
      const now = at("2026-04-05T03:30:00+02:00");
      expect(priorOf(7, now).to).toBe(at("2026-03-29T00:00:00+01:00") + 3.5 * 3_600_000 + 1);
    });
  });

  it("reads the point of a day that skipped an hour as the time really elapsed", () => {
    inZone("Europe/Berlin", () => {
      // 04:00 on Mar 29 is three hours into that day, not four.
      const now = at("2026-03-29T04:00:00+02:00");
      expect(priorOf(7, now).to).toBe(at("2026-03-22T03:00:00+01:00") + 1);
    });
  });

  it("clamps to the prior day's own length when that day was shorter", () => {
    inZone("Europe/Berlin", () => {
      // 23:30 on a 24-hour day, compared with the 23-hour Mar 29: the whole day.
      const now = at("2026-03-30T23:30:00+02:00");
      expect(priorOf(1, now).to).toBe(at("2026-03-30T00:00:00+02:00"));
    });
  });

  it("has no predecessor for the whole ledger", () => {
    const { current, prior } = statsSpans("all", 1_000);
    expect(current.from).toBe(-Infinity);
    expect(inSpan(1_000, current)).toBe(true);
    expect(inSpan(1_001, current)).toBe(false);
    expect(prior).toBeNull();
  });
});
