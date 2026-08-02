import type { UsageWindow } from "./usage";
import { HOUR_MS, DAY_MS } from "./time";

/**
 * The provider-report journal — the forecast's data. Every accepted account
 * report appends one record per window, so pace can be computed from
 * history instead of a single snapshot. Records are keyed by the window's
 * IDENTITY (agent + length + scope) and segmented by window INSTANCE: a
 * pace must never be computed across a reset.
 */

export interface WindowReport {
  agent: string;
  /** The window's identity within the agent — length and scope verbatim;
   * null length is a real value (plan/quota windows). */
  windowMinutes: number | null;
  scope?: string;
  usedPct: number;
  reportedAt: number;
  resetsAt: number | null;
}

/** One journal key per window identity — same shape the provider rows use. */
export function windowReportKey(
  agent: string,
  window: Pick<UsageWindow, "windowMinutes" | "scope">,
): string {
  return `${agent}\0${window.windowMinutes ?? "?"}\0${window.scope ?? ""}`;
}

/** Records worth writing: a change in usage or reset instant, or a slow
 * heartbeat so "the pace is ~zero" stays a fresh fact, not a stale guess.
 * Everything else is statusline chatter. */
export const HEARTBEAT_MS = 5 * 60_000;

export function shouldRecord(
  last: WindowReport | undefined,
  next: WindowReport,
): boolean {
  if (!last) return true;
  if (next.reportedAt <= last.reportedAt) return false;
  if (Math.abs(next.usedPct - last.usedPct) >= 0.1) return true;
  if ((next.resetsAt ?? null) !== (last.resetsAt ?? null)) return true;
  return next.reportedAt - last.reportedAt >= HEARTBEAT_MS;
}

/** A window INSTANCE boundary: usage fell (the window reset and started
 * refilling) or the reset instant moved forward past jitter (a new window
 * took over). The current segment is everything since the last boundary —
 * the only span a pace may be computed over. */
export function currentSegment(
  reports: readonly WindowReport[],
): WindowReport[] {
  let start = 0;
  for (let index = 1; index < reports.length; index += 1) {
    const prev = reports[index - 1];
    const item = reports[index];
    const dropped = item.usedPct < prev.usedPct - 1;
    const resetJumped =
      item.resetsAt !== null &&
      prev.resetsAt !== null &&
      item.resetsAt > prev.resetsAt + 60_000;
    if (dropped || resetJumped) start = index;
  }
  return reports.slice(start);
}

/** Retention per key: about 1.5 window lengths (a full instance plus room
 * for the previous one), clamped so plan windows and month windows stay
 * bounded. Entry cap is a backstop against a chattering reporter. */
export const REPORTS_ENTRY_CAP = 4_000;

export function reportKeepMs(windowMinutes: number | null): number {
  if (windowMinutes === null) return 7 * DAY_MS;
  const span = windowMinutes * 60_000 * 1.5;
  return Math.min(Math.max(span, 6 * HOUR_MS), 45 * DAY_MS);
}

export function pruneReports(
  reports: readonly WindowReport[],
  now: number,
): WindowReport[] {
  const kept = reports.filter(
    (report) => now - report.reportedAt <= reportKeepMs(report.windowMinutes),
  );
  return kept.slice(Math.max(0, kept.length - REPORTS_ENTRY_CAP));
}

/* ---- wire codec: one JSON line per record, tolerant on read ----------- */

export function encodeWindowReport(report: WindowReport): string {
  return JSON.stringify(report);
}

export function decodeWindowReport(line: string): WindowReport | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.agent !== "string" || raw.agent === "") return null;
  if (typeof raw.usedPct !== "number" || !Number.isFinite(raw.usedPct)) {
    return null;
  }
  if (
    typeof raw.reportedAt !== "number" ||
    !Number.isFinite(raw.reportedAt) ||
    raw.reportedAt <= 0
  ) {
    return null;
  }
  const windowMinutes =
    typeof raw.windowMinutes === "number" && Number.isFinite(raw.windowMinutes)
      ? raw.windowMinutes
      : null;
  const resetsAt =
    typeof raw.resetsAt === "number" && Number.isFinite(raw.resetsAt)
      ? raw.resetsAt
      : null;
  return {
    agent: raw.agent,
    windowMinutes,
    ...(typeof raw.scope === "string" && raw.scope !== ""
      ? { scope: raw.scope }
      : {}),
    usedPct: raw.usedPct,
    reportedAt: raw.reportedAt,
    resetsAt,
  };
}
