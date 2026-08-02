import { formatCountdown, usageStale, windowResetCaption } from "./format";
import { currentSegment, type WindowReport } from "./reportJournal";
import { HOUR_MS } from "./time";
import { windowExpired, type UsageWindow } from "./usage";

/**
 * The window-exhaustion forecast — THE one answer to "will this window last
 * to its reset", consumed by every surface (popover caption, card clause,
 * both burn curves). Linear pace over the recent tail of the current window
 * instance; the forecast always names itself an extrapolation ("on pace
 * to…"), never a promise.
 */

export type WindowForecast =
  | { kind: "unknown" }
  /** Survives to the reset; `outAt` is the projected exhaustion anyway
   * (may be past the reset), null when the pace is ~zero. */
  | { kind: "ok"; outAt: number | null }
  | {
      kind: "out";
      outAt: number;
      level: "warn" | "critical";
      /** How much reset the pace does not wait for; null when the window
       * has no known reset to compare against. */
      beforeResetMs: number | null;
    };

/** Pace lookback scales with the window: 45 minutes of reports says a lot
 * about a 5h window and nothing about a week. Null-length (plan) windows
 * get a fixed medium horizon. */
export function forecastLookbackMs(windowMinutes: number | null): number {
  if (windowMinutes === null) return 6 * HOUR_MS;
  const span = windowMinutes * 60_000 * 0.05;
  return Math.min(Math.max(span, 45 * 60_000), 24 * HOUR_MS);
}

/** Verdict margin: "runs out early" only when it beats the reset by more
 * than jitter — a projection landing within the margin of the reset must
 * not flicker between verdicts on every tick. */
function verdictMarginMs(windowMinutes: number | null): number {
  if (windowMinutes === null) return 2 * 60_000;
  return Math.max(2 * 60_000, windowMinutes * 60_000 * 0.02);
}

const MIN_SPAN_MS = 5 * 60_000;

export function windowForecast(
  reports: readonly WindowReport[],
  window: UsageWindow,
  now: number,
): WindowForecast {
  if (windowExpired(window, now)) return { kind: "unknown" };
  const lookback = forecastLookbackMs(window.windowMinutes);
  const tail = currentSegment(reports).filter(
    (report) => report.reportedAt >= now - lookback && report.reportedAt <= now,
  );
  if (tail.length < 2) return { kind: "unknown" };
  const first = tail[0];
  const last = tail[tail.length - 1];
  // A stale journal is dead data — extrapolating it would be a lie, the
  // same rule every stale surface follows (usageStale is the one home).
  if (usageStale(last.reportedAt, now)) return { kind: "unknown" };
  const spanMs = last.reportedAt - first.reportedAt;
  if (spanMs < MIN_SPAN_MS) return { kind: "unknown" };
  const pace = (last.usedPct - first.usedPct) / spanMs; // pct per ms
  if (pace <= 0) return { kind: "ok", outAt: null };
  const outAt = last.reportedAt + (100 - last.usedPct) / pace;
  if (outAt <= now) {
    // Already at the wall by extrapolation — imminent by definition.
    return { kind: "out", outAt: now, level: "critical", beforeResetMs:
      window.resetsAt !== null ? Math.max(0, window.resetsAt - now) : null };
  }
  const level: "warn" | "critical" = outAt - now < HOUR_MS ? "critical" : "warn";
  if (window.resetsAt === null) {
    return { kind: "out", outAt, level, beforeResetMs: null };
  }
  const margin = verdictMarginMs(window.windowMinutes);
  if (outAt < window.resetsAt - margin) {
    return {
      kind: "out",
      outAt,
      level,
      beforeResetMs: window.resetsAt - outAt,
    };
  }
  return { kind: "ok", outAt };
}

/* ---- captions --------------------------------------------------------- */

export interface ForecastCaptionPart {
  text: string;
  level: "warn" | "critical" | null;
}

/** The card's clause — relative, never a second timestamp: "~25m early"
 * against the reset, a countdown when imminent or when there is no reset
 * to compare with. Null when the forecast has nothing to warn about. */
export function forecastClause(
  forecast: WindowForecast,
  now: number,
): ForecastCaptionPart | null {
  if (forecast.kind !== "out") return null;
  if (forecast.level === "critical" || forecast.beforeResetMs === null) {
    return {
      text: `on pace to run out in ~${formatCountdown(forecast.outAt, now) ?? "0m"}`,
      level: forecast.level,
    };
  }
  return {
    text: `on pace to run out ~${
      formatCountdown(now + forecast.beforeResetMs, now) ?? "0m"
    } early`,
    level: "warn",
  };
}

/** The card's full caption, ordered: the reset stays the anchor fact, the
 * clause joins it — and leads it once the run-out is imminent. */
export function cardCaptionParts(
  window: UsageWindow,
  forecast: WindowForecast,
  now: number,
): ForecastCaptionPart[] {
  const reset = windowResetCaption(window, now, "long");
  const clause = forecastClause(forecast, now);
  const parts: ForecastCaptionPart[] = [];
  if (clause !== null && clause.level === "critical") parts.push(clause);
  if (reset !== "") parts.push({ text: reset, level: null });
  if (clause !== null && clause.level !== "critical") parts.push(clause);
  return parts;
}

/** The popover line shows THE next relevant event, always "… in X": the
 * reset caption while the pace survives it, REPLACED by the run-out
 * countdown when it does not. The word swap plus the color IS the verdict. */
export function panelWindowCaption(
  window: UsageWindow,
  forecast: WindowForecast,
  now: number,
): ForecastCaptionPart {
  if (forecast.kind === "out") {
    return {
      text: `runs out in ~${formatCountdown(forecast.outAt, now) ?? "0m"}`,
      level: forecast.level,
    };
  }
  return { text: windowResetCaption(window, now), level: null };
}
