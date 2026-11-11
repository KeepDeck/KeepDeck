import { describe, expect, it } from "vitest";
import {
  localDayNumber,
  localDayStart,
  localHourStart,
  localWeekStart,
  shiftDay,
  type LocalDayNumber,
} from "./time";
import { inZone } from "./time.testSupport";

const at = (iso: string) => new Date(iso).getTime();

describe("the reader's calendar", () => {
  it("starts a day at its local midnight and maps back to the same day", () => {
    inZone("Asia/Nicosia", () => {
      const day = localDayNumber(at("2026-11-10T23:30:00+02:00"));
      const start = localDayStart(day);
      expect(start).toBe(at("2026-11-10T00:00:00+02:00"));
      expect(localDayNumber(start)).toBe(day);
      // The instant before belongs to the day before.
      expect(localDayNumber(start - 1)).toBe(shiftDay(day, -1));
    });
  });

  it("gives a 23-hour and a 25-hour day exactly one ordinal each", () => {
    inZone("Europe/Berlin", () => {
      const spring = localDayNumber(at("2026-03-29T12:00:00+02:00"));
      expect(localDayStart(shiftDay(spring, 1)) - localDayStart(spring)).toBe(23 * 3_600_000);
      const autumn = localDayNumber(at("2026-10-25T12:00:00+01:00"));
      expect(localDayStart(shiftDay(autumn, 1)) - localDayStart(autumn)).toBe(25 * 3_600_000);
    });
  });

  it("opens a day at the first instant that exists when a transition skips midnight", () => {
    // Santiago springs forward at 00:00 → 01:00: that day has no midnight.
    inZone("America/Santiago", () => {
      const day = localDayNumber(at("2026-09-06T12:00:00-03:00"));
      const start = localDayStart(day);
      expect(localDayNumber(start)).toBe(day);
      expect(localDayNumber(start - 1)).toBe(shiftDay(day, -1));
    });
  });

  it("puts every day of a week on its Monday, Sunday included", () => {
    inZone("Asia/Nicosia", () => {
      const monday = localDayNumber(at("2026-11-09T09:00:00+02:00"));
      const sunday = localDayNumber(at("2026-11-15T23:59:00+02:00"));
      expect(localWeekStart(monday)).toBe(monday);
      expect(localWeekStart(sunday)).toBe(monday);
      expect(localWeekStart(shiftDay(sunday, 1) as LocalDayNumber)).toBe(shiftDay(monday, 7));
    });
  });

  it("starts an hour on the reader's own clock, half-hour zones included", () => {
    inZone("Asia/Kolkata", () => {
      expect(localHourStart(at("2026-11-10T10:47:12+05:30"))).toBe(at("2026-11-10T10:00:00+05:30"));
    });
  });
});
