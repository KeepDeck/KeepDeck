import {
  formatCountdown,
  formatMoment,
  formatPct,
  usageStale,
  windowResetCaption,
} from "./format";
import {
  accountWindowKeys,
  currentSegment,
  HEARTBEAT_MS,
  NO_REPORTS,
  type WindowReport,
} from "./reportJournal";
import { HOUR_MS } from "./time";
import { windowExpired, type AccountUsage, type UsageWindow } from "./usage";

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
  | {
      kind: "ok";
      outAt: number | null;
      /** Where the pace LEAVES this window, in percent — its level at the
       * earlier of the run-out and the reset. A forecast fact, not a plot
       * one: it used to be derived inside the burn geometry, which forced
       * every caption that wanted it to build a chart first. Null when
       * there is no pace to extrapolate. */
      endPct: number | null;
    }
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
function forecastLookbackMs(windowMinutes: number | null): number {
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

/** The evidence span a pace needs, scaled like the lookback: five minutes
 * of reports can call a 5h window's pace, but extrapolating a WEEK from a
 * five-minute burst produced "runs out ~6d early" nonsense — a long window
 * must see at least ~1% of its own length before the race is called. */
function forecastMinSpanMs(windowMinutes: number | null): number {
  if (windowMinutes === null) return 15 * 60_000;
  return Math.max(5 * 60_000, windowMinutes * 60_000 * 0.01);
}

export function windowForecast(
  reports: readonly WindowReport[],
  window: UsageWindow,
  now: number,
): WindowForecast {
  if (windowExpired(window, now)) return { kind: "unknown" };
  const lookback = forecastLookbackMs(window.windowMinutes);
  const segment = currentSegment(reports).filter(
    (report) => report.reportedAt <= now,
  );
  // The lookback anchors to the NEWEST REPORT, not the ticking clock: a
  // clock-anchored window silently dropped its oldest report on a tick,
  // flipping the verdict with no new data (review finding). Now only new
  // reports can change the tail.
  const newestAt = segment.length > 0 ? segment[segment.length - 1].reportedAt : 0;
  const tail = segment.filter(
    (report) => report.reportedAt >= newestAt - lookback,
  );
  if (tail.length < 2) return { kind: "unknown" };
  const first = tail[0];
  const last = tail[tail.length - 1];
  // A stale journal is dead data — extrapolating it would be a lie, the
  // same rule every stale surface follows (usageStale is the one home).
  if (usageStale(last.reportedAt, now)) return { kind: "unknown" };
  const spanMs = last.reportedAt - first.reportedAt;
  if (spanMs < forecastMinSpanMs(window.windowMinutes)) {
    return { kind: "unknown" };
  }
  const pace = (last.usedPct - first.usedPct) / spanMs; // pct per ms
  if (pace <= 0) return { kind: "ok", outAt: null, endPct: null };
  const outAt = last.reportedAt + (100 - last.usedPct) / pace;
  if (outAt <= now) {
    // The extrapolation says the wall is already here. That is only
    // credible while reports still flow: with a silent stream (claude is
    // push-stamped and can sit quiet through a long tool call) the honest
    // answer is "don't know", not a red "runs out in ~0m" over an idle
    // account. A verdict computed from a FRESH tail stands untouched
    // through the same silence — only this escalation needs freshness.
    if (now - last.reportedAt > HEARTBEAT_MS + 60_000) {
      return { kind: "unknown" };
    }
    return { kind: "out", outAt: now, level: "critical", beforeResetMs:
      window.resetsAt !== null ? Math.max(0, window.resetsAt - now) : null };
  }
  // Silence must never ESCALATE: a verdict computed from a fresh tail
  // stands through a quiet stretch (claude is push-stamped — a long tool
  // call is silence, not idleness), but while the stream is quiet the
  // countdown may not walk into a red alarm the data never earned. Past
  // the 30-minute stale belt the whole tail is refused above.
  const silent = now - last.reportedAt > HEARTBEAT_MS + 60_000;
  const level: "warn" | "critical" =
    !silent && outAt - now < HOUR_MS ? "critical" : "warn";
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
  // Where the pace leaves the window: its level at the earlier of the
  // run-out and the reset. When the run-out lands INSIDE the verdict margin
  // it is still "ok" — the projection is not confident enough to call a
  // race — but it does reach 100, and the surfaces have to be able to say
  // so. They could not: the level was computed inside the plot geometry,
  // and the caption that needed it bailed out above 99.5%, so this whole
  // band drew a dashed line into the ceiling with nothing naming it.
  const endsAt = Math.min(outAt, window.resetsAt);
  const endPct =
    last.usedPct + (100 - last.usedPct) * ((endsAt - last.reportedAt) / (outAt - last.reportedAt));
  return { kind: "ok", outAt, endPct: Math.min(100, endPct) };
}

/* ---- the account join -------------------------------------------------- */

export interface AccountWindowForecast {
  window: UsageWindow;
  /** The window's journal key (see [`accountWindowKeys`]). */
  key: string;
  /** The key's series; [`NO_REPORTS`] when the journal holds nothing yet. */
  reports: readonly WindowReport[];
  forecast: WindowForecast;
}

/** THE pairing of an account's windows with their journal series and
 * forecasts — every consumer (the panel's rows, the provider cards via
 * providerWindowGroups, the exhaustion notifier) reads this one join
 * instead of re-deriving key → series → forecast on its own. Keyed by
 * window object identity like [`accountWindowKeys`], and keys are minted
 * over the account's OWN report order — the journal writer's rule — so
 * callers may render any re-sorted view (panelWindows) and still look up
 * the right row. */
export function accountWindowForecasts(
  agent: string,
  account: AccountUsage,
  byKey: ReadonlyMap<string, readonly WindowReport[]>,
  now: number,
): ReadonlyMap<UsageWindow, AccountWindowForecast> {
  const rows = new Map<UsageWindow, AccountWindowForecast>();
  if (account.kind !== "reported") return rows;
  for (const [window, entry] of accountWindowKeys(agent, account.windows)) {
    const reports = byKey.get(entry.key) ?? NO_REPORTS;
    rows.set(window, {
      window,
      key: entry.key,
      reports,
      forecast: windowForecast(reports, window, now),
    });
  }
  return rows;
}

/* ---- captions --------------------------------------------------------- */

export interface ForecastCaptionPart {
  text: string;
  level: "warn" | "critical" | null;
}

/**
 * The card's clause. It leads with WHEN — "hits 100% ~Thu 06:40" — because
 * that is the question the curve raises and the one the reader is actually
 * holding: the old phrasing gave only the margin ("~38h 25m early"), which
 * had to be subtracted from a reset countdown printed elsewhere in the same
 * line, in a different unit, to become an answer.
 *
 * The margin survives as the second half, where it belongs: it qualifies
 * the moment rather than standing in for it. An imminent run-out keeps the
 * countdown instead — minutes from now do not need a clock face — and so
 * does a window with no reset to be early against.
 */
function forecastClause(
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
  const early = formatCountdown(now + forecast.beforeResetMs, now);
  const margin = early === null ? "" : ` · ~${early} before reset`;
  // "on pace to", not a bare "hits": this module's contract (top of file)
  // is that a forecast always names itself an extrapolation. The critical
  // arm above kept the hedge; dropping it here attached the STRONGER claim
  // to the WEAKER verdict.
  return {
    text: `on pace to hit 100% ~${formatMoment(forecast.outAt, now)}${margin}`,
    level: "warn",
  };
}

/**
 * Does the reset arrive before the pace does?
 *
 * THE one home of the capping rule. The burn plot ends its axis at
 * `min(outAt, resetsAt)` and the edge label has to name whichever of the
 * two that was — asking the question in both places let one of them be
 * merely handed the answer, which is how the label ended up needing a plot
 * before it could be built.
 */
export function resetCapsProjection(
  window: UsageWindow,
  forecast: WindowForecast,
  now: number,
): boolean {
  if (window.resetsAt === null) return false;
  const outAt = forecast.kind === "unknown" ? null : forecast.outAt;
  return outAt !== null && outAt >= now && outAt >= window.resetsAt;
}

/**
 * What the burn plot's RIGHT EDGE is, as a moment.
 *
 * The axis runs from the window's first report to wherever the projection
 * ends, so that edge already IS the answer to "when do I hit 100%" — the
 * out-dot sits on it. It was labelled "reset" or nothing at all, which left
 * the most-asked question drawn but unnamed, and left the reader deriving a
 * clock time from a countdown printed in a different line.
 */
export interface BurnEdge extends ForecastCaptionPart {
  /** The edge IS the reset. The plot rules a boundary line there; asking
   * this of the label rather than sniffing its text keeps the two from
   * having separate opinions about the same edge. */
  atReset: boolean;
}

export function burnEdgeLabel(
  window: UsageWindow,
  forecast: WindowForecast,
  now: number,
): BurnEdge {
  if (resetCapsProjection(window, forecast, now)) {
    return {
      text: `reset ${formatMoment(window.resetsAt!, now)}`,
      level: null,
      atReset: true,
    };
  }
  if (forecast.kind === "out") {
    return {
      text: formatMoment(forecast.outAt, now),
      level: forecast.level,
      atReset: false,
    };
  }
  // "ok" whose pace still reaches the ceiling before the reset — inside the
  // verdict margin, so not a race, but the dashed line does end AT 100 and
  // the edge is that instant. This band drew into the corner unnamed.
  if (forecast.kind === "ok" && forecast.outAt !== null) {
    return {
      text: formatMoment(forecast.outAt, now),
      level: null,
      atReset: false,
    };
  }
  // No projection at all — the axis simply ends at now. Saying so is what
  // turns an empty right half into "nothing has been reported since": the
  // curve stops where the reports stopped, and without this the gap reads
  // as a chart that failed to draw.
  return { text: "now", level: null, atReset: false };
}

/**
 * What a SURVIVING window has to say: "lasts the window · ends near 33%".
 *
 * The quiet case used to draw a curve and report only the reset time, so
 * the most common state — everything is fine — was also the least legible:
 * a line climbing across a frame with no verdict attached to it. Naming the
 * landing percentage is what turns the shape into information.
 *
 * Only with a real projection to land on, and only below the ceiling; a
 * pace of about zero has nothing to extrapolate and says nothing.
 */
function survivalClause(forecast: WindowForecast): ForecastCaptionPart | null {
  if (forecast.kind !== "ok" || forecast.endPct === null) return null;
  // `formatPct`, not a local round: every other percentage on this card
  // goes through it, and it ceils on purpose (understating consumption
  // reads as a bug — the field report is in its doc). A local `Math.round`
  // here made the chart's own hover tooltip say "34% used" while the
  // sentence beneath it said "ends near 33%", about the same point.
  const pct = formatPct(forecast.endPct, "used");
  // A pace that reaches the ceiling inside the verdict margin is not a
  // race — too close to call — but it is not "lasts the window" either.
  return forecast.endPct >= 99.5
    ? { text: `on pace to reach ${pct} by the reset`, level: "warn" }
    : { text: `on pace to last the window · ends near ${pct}`, level: null };
}

/** The card's full caption, ordered: the reset stays the anchor fact, the
 * clause joins it — and leads it once the run-out is imminent. */
export function cardCaptionParts(
  window: UsageWindow,
  forecast: WindowForecast,
  now: number,
): ForecastCaptionPart[] {
  const reset = windowResetCaption(window, now, "long");
  const clause = forecastClause(forecast, now) ?? survivalClause(forecast);
  const parts: ForecastCaptionPart[] = [];
  if (clause !== null && clause.level === "critical") parts.push(clause);
  if (reset !== "") parts.push({ text: reset, level: null });
  if (clause !== null && clause.level !== "critical") parts.push(clause);
  return parts;
}

/** THE run-out phrase — "runs out in ~12m" — one wording for the fact,
 * composed into a different sentence by each surface (the popover line,
 * the exhaustion-alarm title). The surfaces may drift in COMPOSITION, never
 * in the phrase itself. */
export function runOutCountdown(outAt: number, now: number): string {
  return `runs out in ~${formatCountdown(outAt, now) ?? "0m"}`;
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
      text: runOutCountdown(forecast.outAt, now),
      level: forecast.level,
    };
  }
  return { text: windowResetCaption(window, now), level: null };
}
