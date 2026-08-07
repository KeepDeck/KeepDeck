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
 * both burn curves). A recency-weighted pace over the recent tail of the
 * current window instance.
 *
 * The captions used to hedge every sentence with "on pace to…", so that the
 * forecast named itself an extrapolation. That was traded away deliberately:
 * four of six states opened with the same three words, which pushed the
 * verdict into the middle of the sentence and left `hit 100%` and `last the
 * window` in the same position — one word apart on screen, opposite in
 * consequence. The hedge now lives in the "~" before every quantity and in
 * the uncoloured margin band, and the sentence spends its first word on the
 * verdict instead.
 */

/**
 * Four disjoint answers, every field required.
 *
 * It used to be three, with `outAt` and `endPct` as parallel nullables that
 * were null together and set together by construction — nothing in the type
 * said so, and three consumers discriminated on DIFFERENT members of that
 * pair. Worse, `ok` quietly covered two opposite situations: a pace that
 * never reaches the ceiling, and one that reaches it just before the reset.
 * A caption that read the union as "ok means fine" therefore printed "Won't
 * hit the limit" over a projection that hits it — up to 3h22m early on a
 * week window, under a plot whose own edge label named the instant.
 */
export type WindowForecast =
  /** No projection may be made: too few reports, too short a span, a stale
   * journal, an expired window — or a pace that came out NEGATIVE, which
   * means the journal is contradicting itself and is not evidence of
   * anything. */
  | { kind: "unknown" }
  /** Reports, and no growth at all across the tail. A real answer, and a
   * different one from "cannot say". */
  | { kind: "idle" }
  /** The pace does not reach the ceiling before the reset. */
  | {
      kind: "lasts";
      /** Where the pace WOULD hit 100 — at or after the reset. The burn plot
       * needs it to draw the line; the caption does not. */
      outAt: number;
      /** Where the pace leaves this window, in percent, at the reset. A
       * forecast fact, not a plot one: it used to be derived inside the burn
       * geometry, which forced every caption that wanted it to build a chart
       * first. */
      endPct: number;
    }
  /** The pace reaches the ceiling before the reset. `level` is null when it
   * lands inside `verdictMarginMs` of the reset — real, but too close to
   * call, so it is stated without colour and never alarms. */
  | { kind: "out"; outAt: number; level: "warn" | "critical" | null };

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

/**
 * Percent per millisecond across the tail — a slope fitted over every
 * reading, weighted toward the RECENT ones.
 *
 * Two forces, and only a weighted fit satisfies both.
 *
 * The reporters send WHOLE percents, so a real journal reads 10, 11, 10, 11,
 * 12, 13, 12 …: every value carries up to a point of quantisation noise.
 * Taking the line through the two endpoints put all of that noise on the
 * slope and used none of the twenty readings between — measured on a real
 * 44-minute tail, it understated a 0.160 %/min climb as 0.114.
 *
 * But an unweighted fit is ORDER-BLIND, and pace is not. Measured on two
 * opposite ten-point tails — nine flat readings then a jump (someone just
 * started working, the wall is five minutes away) versus a jump then nine
 * flat (someone spent and went to read, the wall is never) — a plain
 * least-squares slope returns the SAME 0.327 %/min for both, which pushes
 * the run-out past the critical hour and silences the exhaustion alarm on
 * the dangerous one. For an alarm that is the wrong way to be wrong.
 *
 * Halving weight every third of the tail's span keeps the noise averaging
 * (0.148 against a true 0.160) while restoring the distinction: 51 minutes
 * on the hard turn — alarm fires — against 179 on the one that idled, where
 * the endpoint line would have raised a false alarm at 45. A steady climb is
 * unaffected: all three methods agree exactly.
 *
 * The projection ORIGIN stays the raw newest report: the extrapolation has
 * to start from what the provider currently says, not from a fitted value no
 * report ever claimed.
 */
function tailPace(tail: readonly WindowReport[]): number {
  const newest = tail[tail.length - 1];
  const halfLifeMs = (newest.reportedAt - tail[0].reportedAt) / 3;
  // Both axes are measured FROM the newest report. A slope is invariant
  // under shifting either axis, and shifting buys exactness where it
  // matters most: on a genuinely flat tail every shifted percentage is
  // exactly zero, so the covariance is exactly zero and the answer is
  // exactly `idle`. Centering on the weighted mean instead left a
  // few-ulp residue, which turned "nothing is being spent" into a pace of
  // 1e-19 %/ms and a run-out some centuries out — reported as a window
  // that lasts. It also keeps the arithmetic away from the 1.79e12
  // magnitude of a raw unix instant.
  const at = (report: WindowReport) => report.reportedAt - newest.reportedAt;
  const pct = (report: WindowReport) => report.usedPct - newest.usedPct;
  const weightOf = (report: WindowReport) =>
    halfLifeMs > 0 ? 2 ** (at(report) / halfLifeMs) : 1;

  let weight = 0;
  let sumAt = 0;
  let sumPct = 0;
  for (const report of tail) {
    const w = weightOf(report);
    weight += w;
    sumAt += w * at(report);
    sumPct += w * pct(report);
  }
  const meanAt = sumAt / weight;
  const meanPct = sumPct / weight;

  let covariance = 0;
  let variance = 0;
  for (const report of tail) {
    const w = weightOf(report);
    const dt = at(report) - meanAt;
    covariance += w * dt * (pct(report) - meanPct);
    variance += w * dt * dt;
  }
  // Unreachable — the min-span gate above guarantees distinct instants — but
  // a zero here would be a divide by zero rather than a wrong answer.
  return variance === 0 ? 0 : covariance / variance;
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
  const pace = tailPace(tail); // pct per ms
  // Flat and FALLING are different answers. Flat is a fact about the reader:
  // nothing is being spent. Falling is a fact about the DATA: a counter that
  // only ever grows has gone down, so this tail straddles something the
  // segmentation could not see — a provider that reset but lagged its
  // `resetsAt`, or a cross-pane correction. Calling that "not spending"
  // states a confident falsehood over a window that may be climbing hard,
  // and it did: after a lagged reset the card read "Not spending right now"
  // for a whole lookback horizon — 45 minutes on a 5h window, over 8 hours
  // on a weekly one.
  if (pace < 0) return { kind: "unknown" };
  if (pace === 0) return { kind: "idle" };
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
    return { kind: "out", outAt: now, level: "critical" };
  }
  // Silence must never ESCALATE: a verdict computed from a fresh tail
  // stands through a quiet stretch (claude is push-stamped — a long tool
  // call is silence, not idleness), but while the stream is quiet the
  // countdown may not walk into a red alarm the data never earned. Past
  // the 30-minute stale belt the whole tail is refused above.
  const silent = now - last.reportedAt > HEARTBEAT_MS + 60_000;
  const level: "warn" | "critical" =
    !silent && outAt - now < HOUR_MS ? "critical" : "warn";
  // No reset to race: a positive pace always arrives at the ceiling.
  if (window.resetsAt === null) return { kind: "out", outAt, level };
  // Past the reset — the pace never gets there. THE survival case.
  if (outAt >= window.resetsAt) {
    const endPct =
      last.usedPct + pace * (window.resetsAt - last.reportedAt);
    return { kind: "lasts", outAt, endPct: Math.min(100, endPct) };
  }
  // Before the reset, so the limit IS reached — the only question is whether
  // that is worth colouring. Inside the verdict margin the projection is not
  // confident enough to call a race, and a jittering verdict at the boundary
  // is worse than none. So: stated, uncoloured, never alarmed on.
  //
  // This band used to be folded into the survival case, where a caption read
  // "ok" as "fine" and printed "Won't hit the limit" over a projection that
  // hits it — up to 3h22m early on a week window, with the plot's own edge
  // label naming the instant the sentence denied.
  if (outAt >= window.resetsAt - verdictMarginMs(window.windowMinutes)) {
    return { kind: "out", outAt, level: null };
  }
  return { kind: "out", outAt, level };
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
 * The card's clause for a window that reaches the ceiling.
 *
 * It counts DOWN rather than naming a clock time, and carries no margin. The
 * old phrasing did both — "hits 100% ~Thu 06:40 · ~38h 25m before reset" —
 * which put three time references in one line, in three systems: a countdown
 * (the reset, printed beside it), a clock face, and a difference between
 * them. The margin is derivable from the two numbers already on the line,
 * and nobody subtracts clocks in their head.
 *
 * `level` passes through untouched, INCLUDING null: the margin band reaches
 * the limit like any other `out`, it simply is not worth colouring.
 */
function forecastClause(
  forecast: WindowForecast,
  now: number,
): ForecastCaptionPart | null {
  if (forecast.kind !== "out") return null;
  return { text: runOutPhrase(forecast.outAt, now, "lead"), level: forecast.level };
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
  if (forecast.kind !== "lasts" && forecast.kind !== "out") return false;
  return forecast.outAt >= now && forecast.outAt >= window.resetsAt;
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
  // Every projection that reaches the ceiling before the reset — including
  // the uncoloured margin band, which used to need its own branch here
  // because the union could not say what it was.
  if (forecast.kind === "out") {
    return {
      text: formatMoment(forecast.outAt, now),
      level: forecast.level,
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
 * The card's clause for a window the pace does not exhaust.
 *
 * It names what is LEFT at the reset, not where the line stops. "ends near
 * 33%" described the curve; nobody is holding a curve, they are holding a
 * budget, and the useful quantity is the headroom.
 *
 * Through `formatPct`'s own "left" mode, not a hand-rolled complement: that
 * mode ceils the USED side on purpose (understating consumption reads as a
 * bug — the field report is in its doc), so ceiling `100 - endPct` instead
 * rounds the wrong way and overstates headroom by up to a point.
 */
function survivalClause(forecast: WindowForecast): ForecastCaptionPart | null {
  if (forecast.kind !== "lasts") return null;
  return {
    text: `Won't hit the limit · ~${formatPct(forecast.endPct, "left")}`,
    level: null,
  };
}

/**
 * The card's clause when there is no projection — a named function like its
 * two siblings rather than a ternary inside the composer, so the composer
 * only ORDERS clauses and never authors one.
 *
 * The two silences are different answers and now say so: reports with no
 * growth mean the reader is not spending, while too few reports, too short a
 * span, a stale journal or a self-contradicting one mean the module cannot
 * say. Saying either is what keeps an empty card from reading as a broken
 * one, and is also what explains the burn plot's empty right half.
 *
 * An EXPIRED window is neither. Its percentage belongs to a window that is
 * gone, the card already says "reset passed" above, and "Not enough data
 * yet" over it would blame the journal for a fact about the clock.
 */
function quietClause(
  window: UsageWindow,
  forecast: WindowForecast,
  now: number,
): ForecastCaptionPart | null {
  if (forecast.kind === "idle") {
    return { text: "Not spending right now", level: null };
  }
  if (forecast.kind !== "unknown" || windowExpired(window, now)) return null;
  return { text: "Not enough data yet", level: null };
}

/** The card's full caption, ordered: the reset stays the anchor fact, the
 * clause joins it — and leads it once the run-out is imminent. */
export function cardCaptionParts(
  window: UsageWindow,
  forecast: WindowForecast,
  now: number,
): ForecastCaptionPart[] {
  const reset = windowResetCaption(window, now, "long");
  const clause =
    forecastClause(forecast, now) ??
    survivalClause(forecast) ??
    quietClause(window, forecast, now);
  const parts: ForecastCaptionPart[] = [];
  if (clause !== null && clause.level === "critical") parts.push(clause);
  if (reset !== "") parts.push({ text: reset, level: null });
  if (clause !== null && clause.level !== "critical") parts.push(clause);
  return parts;
}

/**
 * THE run-out phrase — one wording for the fact, in the two grammatical
 * positions its surfaces need.
 *
 * `"join"` continues a sentence ("claude 5h window **hits the limit in
 * ~12m**"); `"lead"` starts one ("**Will hit the limit in ~12m**"). That is
 * the only difference, and having it here is what keeps it the only one:
 * the card briefly grew its own literal, and two independent strings for one
 * fact is exactly how the popover and the notification start describing the
 * same window differently after the next rewording.
 *
 * "the limit" and not "100%": a percentage is a number, and what the reader
 * needs is the thing they run into.
 */
export function runOutPhrase(
  outAt: number,
  now: number,
  form: "join" | "lead",
): string {
  const countdown = formatCountdown(outAt, now);
  // The wall is here — nothing to count down to, so the fact is the whole
  // phrase.
  if (countdown === null) return form === "lead" ? "Limit reached" : "limit reached";
  const verb = form === "lead" ? "Will hit" : "hits";
  return `${verb} the limit in ~${countdown}`;
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
      text: runOutPhrase(forecast.outAt, now, "join"),
      level: forecast.level,
    };
  }
  return { text: windowResetCaption(window, now), level: null };
}
