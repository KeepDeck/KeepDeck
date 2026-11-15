import { INSTANCE_JUMP_MS, windowInstances, type WindowReport } from "./reportJournal";
import type { UsageWindow } from "./usage";

/**
 * A window's earlier instances, as the report journal still holds them —
 * so the Limits tab can lay the last windows under this one, on the same
 * clock, and say where the last one stood at this point of its own.
 *
 * Only what the journal keeps: about one and a half window lengths
 * (reportJournal's retention), so the previous window and the tail of the
 * one before at most. An instance the journal holds from its middle on is
 * shown from there — never filled in.
 */
export interface EarlierWindow {
  startsAt: number;
  resetsAt: number;
  /** The highest reading the journal holds for it. */
  peakPct: number;
  /** Its readings inside its own span, oldest first. */
  readings: readonly WindowReport[];
}

/** The instances before the current one, oldest first — only those whose
 * reset is known, since a window is placed on its clock by its reset and
 * the length the current one states. */
export function earlierWindows(
  reports: readonly WindowReport[],
  window: Pick<UsageWindow, "resetsAt" | "windowMinutes">,
): EarlierWindow[] {
  const { resetsAt: current, windowMinutes } = window;
  if (current === null || windowMinutes === null) return [];
  const length = windowMinutes * 60_000;
  return windowInstances(reports).flatMap((instance) => {
    const resetsAt = instance[instance.length - 1]?.resetsAt ?? null;
    // The current instance, or one that ended at the same reset: not earlier.
    if (resetsAt === null || resetsAt > current - INSTANCE_JUMP_MS) return [];
    const startsAt = resetsAt - length;
    const readings = instance.filter((report) => report.reportedAt >= startsAt && report.reportedAt <= resetsAt);
    if (readings.length === 0) return [];
    const peakPct = readings.reduce((top, report) => Math.max(top, report.usedPct), 0);
    return [{ startsAt, resetsAt, peakPct, readings }];
  });
}

/** Where an earlier window stood `elapsedMs` into its own span — its last
 * reading at or before that point — or null when the journal does not
 * reach back that far: an unknown is not a zero. */
export function readingAt(earlier: EarlierWindow, elapsedMs: number): number | null {
  const at = earlier.startsAt + elapsedMs;
  let reading: number | null = null;
  for (const report of earlier.readings) {
    if (report.reportedAt > at) break;
    reading = report.usedPct;
  }
  return reading;
}
