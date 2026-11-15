import { describe, expect, it } from "vitest";
import { windowInstances } from "./reportJournal";
import { TEST_NOW, windowReport as report } from "./reportJournal.testSupport";
import type { UsageWindow } from "./usage";
import { earlierWindows, previousWindow, readingAt } from "./windowHistory";
import { windowVerdict } from "./windowForecast";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = TEST_NOW;
const WEEK_MIN = 7 * 24 * 60;
/** The current week: began a day ago, resets in six. */
const RESET = NOW + 6 * DAY;
const WEEK: UsageWindow = { usedPct: 3, resetsAt: RESET, windowMinutes: WEEK_MIN };
const PREVIOUS_RESET = RESET - 7 * DAY;
const OLDER_RESET = PREVIOUS_RESET - 7 * DAY;

const at = (reportedAt: number, usedPct: number, resetsAt: number) =>
  report({ windowMinutes: WEEK_MIN, reportedAt, usedPct, resetsAt });

/** The tail of the week before last, the whole last week, this one so far. */
const JOURNAL = [
  at(OLDER_RESET - 2 * DAY, 80, OLDER_RESET),
  at(OLDER_RESET - HOUR, 97, OLDER_RESET),
  at(PREVIOUS_RESET - 7 * DAY + HOUR, 1, PREVIOUS_RESET),
  at(PREVIOUS_RESET - 6 * DAY, 14, PREVIOUS_RESET),
  at(PREVIOUS_RESET - 2 * DAY, 56, PREVIOUS_RESET),
  at(RESET - 7 * DAY + HOUR, 1, RESET),
  at(NOW - HOUR, 3, RESET),
];

describe("windowInstances", () => {
  it("cuts a journal at every reset it turned over at, oldest first", () => {
    expect(windowInstances(JOURNAL).map((instance) => instance.map((r) => r.usedPct))).toEqual([[80, 97], [1, 14, 56], [1, 3]]);
    expect(windowInstances([])).toEqual([]);
  });
});

describe("earlierWindows", () => {
  it("lays the instances before this one on their own spans, with their peaks", () => {
    const earlier = earlierWindows(JOURNAL, WEEK);
    expect(earlier.map((e) => [e.startsAt, e.resetsAt, e.peakPct, e.readings.length])).toEqual([
      [OLDER_RESET - 7 * DAY, OLDER_RESET, 97, 2],
      [PREVIOUS_RESET - 7 * DAY, PREVIOUS_RESET, 56, 3],
    ]);
  });

  it("has nothing to lay without a reset or a length, or before any turnover", () => {
    expect(earlierWindows(JOURNAL, { ...WEEK, resetsAt: null })).toEqual([]);
    expect(earlierWindows(JOURNAL, { ...WEEK, windowMinutes: null })).toEqual([]);
    expect(earlierWindows(JOURNAL.slice(-2), WEEK)).toEqual([]);
  });
});

describe("previousWindow", () => {
  const earlier = earlierWindows(JOURNAL, WEEK);
  const startsAt = RESET - 7 * DAY;

  it("is the window that ended just before this one began", () => {
    expect(previousWindow(earlier, startsAt, 7 * DAY)?.resetsAt).toBe(PREVIOUS_RESET);
  });

  it("is none when the journal holds only an older one — the one between was missed", () => {
    expect(previousWindow(earlier.slice(0, 1), startsAt, 7 * DAY)).toBeNull();
    expect(previousWindow([], startsAt, 7 * DAY)).toBeNull();
  });
});

describe("readingAt", () => {
  const [older, previous] = earlierWindows(JOURNAL, WEEK);

  it("says where an earlier window stood at the same point of its own span", () => {
    if (!previous) throw new Error("no previous window");
    // A day and a half in: the 14% read on its second day.
    expect(readingAt(previous, DAY + 12 * HOUR)).toBe(14);
    expect(readingAt(previous, 7 * DAY)).toBe(56);
  });

  it("refuses a point the journal no longer reaches back to — an unknown is not a zero", () => {
    if (!older) throw new Error("no older window");
    expect(readingAt(older, DAY)).toBeNull();
    expect(readingAt(older, 6 * DAY)).toBe(80);
  });
});

describe("windowVerdict", () => {
  it("says the forecast alone, and nothing for a window that has reset", () => {
    expect(windowVerdict(WEEK, { kind: "idle" }, NOW)).toEqual({ text: "Not spending right now", level: null });
    expect(windowVerdict(WEEK, { kind: "out", outAt: NOW + 2 * HOUR, level: "warn" }, NOW)).toEqual({
      text: "Will hit the limit in ~2h 0m",
      level: "warn",
    });
    expect(windowVerdict({ ...WEEK, resetsAt: NOW - HOUR }, { kind: "unknown" }, NOW)).toBeNull();
  });
});
